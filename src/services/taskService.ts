import { v4 as uuidv4 } from 'uuid';
import { Task, SyncQueueItem } from '../types';
import { Database } from '../db/database';

type DbParam = string | number | null;

export class TaskService {
  constructor(private db: Database) {}

  private mapRowToTask(row: any): Task | null {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status,
      server_id: row.server_id,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : null, // Correctly returns null
    };
  }

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
      last_synced_at: null, // Assign null directly (matches Task type)
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
      newTask.last_synced_at, // Pass null
    ]);

    await this.addToSyncQueue(newTask.id, 'create', { ...newTask });

    return newTask;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existingTask = await this.getTask(id);
    if (!existingTask) {
      console.log(`Update failed: Task ${id} not found or deleted.`);
      return null;
    }

    const now = new Date();
    const metadataUpdates = {
        updated_at: now,
        sync_status: 'pending' as const
    };
    const allUpdates = { ...updates, ...metadataUpdates };

    const fields = Object.keys(allUpdates);
    const validFields = fields.filter(field => allUpdates[field as keyof typeof allUpdates] !== undefined);

    if (validFields.length === 0) {
        console.log("No valid fields provided for update, only updating timestamp/status.");
        // Still need to update timestamp and status if only invalid fields were passed
        const tsUpdateSql = `UPDATE tasks SET updated_at = ?, sync_status = 'pending' WHERE id = ?`;
        await this.db.run(tsUpdateSql, [now.toISOString(), id]);
        if (Object.keys(updates).length > 0) { // Check original updates
            await this.addToSyncQueue(id, 'update', updates);
        }
        return this.getTask(id);
    }

    const setClauses = validFields.map(field => `${field} = ?`).join(', ');

    // Convert values to DbParam[] right here
    const params: DbParam[] = validFields.map(field => {
        const value = allUpdates[field as keyof typeof allUpdates];
        if (value instanceof Date) {
            return value.toISOString();
        }
        if (typeof value === 'boolean') {
            return value ? 1 : 0;
        }
        // Ensure only string, number, or null are returned
        return (typeof value === 'string' || typeof value === 'number' || value === null) ? value : null;
    });

    params.push(id); // Add ID for WHERE clause

    const sql = `UPDATE tasks SET ${setClauses} WHERE id = ?`;

    await this.db.run(sql, params); // Use the correctly typed params array
    console.log(`Updated task ${id}.`);

    await this.addToSyncQueue(id, 'update', updates);

    return this.getTask(id);
}


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

  async getTask(id: string): Promise<Task | null> {
    const sql = `SELECT * FROM tasks WHERE id = ? AND is_deleted = 0`;
    const row = await this.db.get(sql, [id]);
    return this.mapRowToTask(row);
  }

  async getAllTasks(): Promise<Task[]> {
    const sql = `SELECT * FROM tasks WHERE is_deleted = 0 ORDER BY created_at DESC`;
    const rows = await this.db.all(sql);
    return rows.map(row => this.mapRowToTask(row)).filter((task): task is Task => task !== null);
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    const sql = `SELECT * FROM tasks WHERE sync_status = 'pending' OR sync_status = 'error'`;
    const rows = await this.db.all(sql);
    return rows.map(row => this.mapRowToTask(row)).filter((task): task is Task => task !== null);
  }
}

