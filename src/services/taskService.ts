import { v4 as uuidv4 } from 'uuid';
import { Task, SyncQueueItem } from '../types';
import { Database } from '../db/database';

type DbParam = string | number | null;

// Raw DB row structure for tasks.
interface TaskDbRow {
  id: string;
  title: string;
  description: string | null;
  completed: number;
  created_at: string;
  updated_at: string;
  is_deleted: number;
  sync_status: 'pending' | 'synced' | 'error' | 'in-progress' | 'failed';
  server_id: string | null;
  last_synced_at: string | null;
}

/**
 * Service for task CRUD operations and sync queue management.
 */
export class TaskService {
  // Initializes service with database instance.
  constructor(private db: Database) {}

  // Maps a raw database row to a Task object, handling type conversions.
  private mapRowToTask(row: TaskDbRow | null): Task | null {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status || 'pending',
      server_id: row.server_id ?? undefined,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : null,
    };
  }

  // Adds an operation record to the sync queue table.
  private async addToSyncQueue(
    taskId: string,
    operation: 'create' | 'update' | 'delete',
    data: Partial<Task>,
  ): Promise<void> {
    const queueItem: Omit<SyncQueueItem, 'created_at' | 'retry_count'> & { created_at: Date; retry_count: number } = {
      id: uuidv4(),
      task_id: taskId,
      operation,
      data,
      created_at: new Date(),
      retry_count: 0,
    };
    const sql = `
      INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    // Store 'data' as JSON string for flexibility.
    await this.db.run(sql, [
      queueItem.id,
      queueItem.task_id,
      queueItem.operation,
      JSON.stringify(queueItem.data),
      queueItem.created_at.toISOString(),
      queueItem.retry_count,
    ]);
     console.log(`Added ${operation} for task ${taskId} to sync queue.`);
  }

  // Creates a task locally and queues it for synchronization.
  async createTask(taskData: Partial<Task>): Promise<Task> {
    const now = new Date();
    const newTask: Task = {
      id: uuidv4(), 
      title: taskData.title || 'Untitled Task',
      description: taskData.description || undefined,
      completed: false,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      sync_status: 'pending',
      server_id: undefined,
      last_synced_at: null,
    };
    const sql = `
      INSERT INTO tasks (
        id, title, description, completed, created_at, updated_at,
        is_deleted, sync_status, server_id, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await this.db.run(sql, [
      newTask.id,
      newTask.title,
      newTask.description,
      newTask.completed ? 1 : 0,
      newTask.created_at.toISOString(),
      newTask.updated_at.toISOString(),
      newTask.is_deleted ? 1 : 0,
      newTask.sync_status,
      newTask.server_id,
      newTask.last_synced_at,
    ]);
    await this.addToSyncQueue(newTask.id, 'create', { ...newTask }); 
    return newTask;
  }

  // Updates a task locally and queues the update for synchronization.
  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existingTask = await this.getTask(id);
    if (!existingTask) { 
      console.log(`Update failed: Task ${id} not found or deleted.`);
      return null;
    }
    const now = new Date();
    const metadataUpdates = { updated_at: now, sync_status: 'pending' as const };
    const allUpdates = { ...updates, ...metadataUpdates }; 
    const fields = Object.keys(allUpdates);
    const validFields = fields.filter(field =>
        allUpdates[field as keyof typeof allUpdates] !== undefined &&
        ['title', 'description', 'completed', 'updated_at', 'sync_status'].includes(field)
    );
    // Handle case where only invalid field names were passed
    if (validFields.length === 0) {
        console.log("No valid update fields provided, only updating metadata if necessary.");
        if (Object.keys(updates).length > 0) {
            const tsUpdateSql = `UPDATE tasks SET updated_at = ?, sync_status = 'pending' WHERE id = ?`;
            await this.db.run(tsUpdateSql, [now.toISOString(), id]);
            await this.addToSyncQueue(id, 'update', updates); 
        }
        return this.getTask(id);
    }
    // Build SQL query dynamically
    const setClauses = validFields.map(field => `${field} = ?`).join(', ');
    const params: DbParam[] = validFields.map(field => {
        const value = allUpdates[field as keyof typeof allUpdates];
        if (value instanceof Date) return value.toISOString();
        if (typeof value === 'boolean') return value ? 1 : 0;
        return (typeof value === 'string' || typeof value === 'number' || value === null) ? value : null;
    });
    params.push(id); 
    const sql = `UPDATE tasks SET ${setClauses} WHERE id = ?`;
    await this.db.run(sql, params);
    console.log(`Updated task ${id}.`);
    
    await this.addToSyncQueue(id, 'update', updates);
    return this.getTask(id);
}

  // Soft deletes a task locally and queues the delete for synchronization.
  async deleteTask(id: string): Promise<boolean> {
    const existingTask = await this.getTask(id); 
    if (!existingTask) {
       console.log(`Delete failed: Task ${id} not found or already deleted.`);
      return false;
    }
    const now = new Date();
    
    const sql = `
      UPDATE tasks
      SET is_deleted = 1, updated_at = ?, sync_status = 'pending'
      WHERE id = ?
    `;
    await this.db.run(sql, [now.toISOString(), id]);
    console.log(`Soft deleted task ${id}.`);
    await this.addToSyncQueue(id, 'delete', { id }); 
    return true;
  }

  // Retrieves a single non-deleted task by ID.
  async getTask(id: string): Promise<Task | null> {
    const sql = `SELECT * FROM tasks WHERE id = ? AND is_deleted = 0`;
    const row = await this.db.get(sql, [id]) as TaskDbRow | null;
    return this.mapRowToTask(row); 
  }

  // Retrieves all non-deleted tasks, ordered by creation date.
  async getAllTasks(): Promise<Task[]> {
    const sql = `SELECT * FROM tasks WHERE is_deleted = 0 ORDER BY created_at DESC`; 
    const rows = await this.db.all(sql) as TaskDbRow[];
    return rows.map(row => this.mapRowToTask(row)).filter((task): task is Task => task !== null); 
  }

  // Retrieves tasks marked as 'pending' or 'error' for synchronization.
  async getTasksNeedingSync(): Promise<Task[]> {
    const sql = `SELECT * FROM tasks WHERE sync_status = 'pending' OR sync_status = 'error'`;
    const rows = await this.db.all(sql) as TaskDbRow[];
    return rows.map(row => this.mapRowToTask(row)).filter((task): task is Task => task !== null); 
  }
}