import { v4 as uuidv4 } from 'uuid';
import { Task, SyncQueueItem } from '../types'; // Ensure Task is imported
import { Database } from '../db/database';

type DbParam = string | number | null;

// Describes the raw row from the tasks table
interface TaskDbRow {
  id: string;
  title: string;
  description: string | null; // DB might return null
  completed: number;          // DB stores boolean as 0 or 1
  created_at: string;         // DB returns ISO string
  updated_at: string;         // DB returns ISO string
  is_deleted: number;         // DB stores boolean as 0 or 1
  sync_status: 'pending' | 'synced' | 'error' | 'in-progress' | 'failed'; // Match Task['sync_status']
  server_id: string | null;   // DB might return null
  last_synced_at: string | null; // DB returns ISO string or null
}

export class TaskService {
  constructor(private db: Database) {}

  // --- FIX: Changed 'any' to 'TaskDbRow | null' and adjusted logic ---
  private mapRowToTask(row: TaskDbRow | null): Task | null {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      // Use nullish coalescing for description
      description: row.description ?? undefined,
      completed: !!row.completed, // Convert number (0/1) to boolean
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted, // Convert number (0/1) to boolean
      // Ensure the type matches the Task interface sync_status
      sync_status: row.sync_status || 'pending', // Default to pending if null/undefined in DB for some reason
      // Use nullish coalescing for server_id
      server_id: row.server_id ?? undefined,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : null,
    };
  }
  // ---------------------------------------------------------------------

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
    // Filter out undefined and ensure keys are valid Task keys before creating clauses
    const validFields = fields.filter(field =>
        allUpdates[field as keyof typeof allUpdates] !== undefined &&
        ['title', 'description', 'completed', 'updated_at', 'sync_status'].includes(field) // Only allow specific fields
    );


    if (validFields.length === 0) {
        console.log("No valid update fields provided, only updating metadata if necessary.");
        // Check if only metadata needs updating (e.g., if invalid fields were passed)
        if (Object.keys(updates).length > 0) {
            const tsUpdateSql = `UPDATE tasks SET updated_at = ?, sync_status = 'pending' WHERE id = ?`;
            await this.db.run(tsUpdateSql, [now.toISOString(), id]);
            await this.addToSyncQueue(id, 'update', updates); // Add original updates to queue
        }
        return this.getTask(id); // Return potentially unchanged task (except metadata)
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
        // Ensure only string, number, null or specific string literals are returned
        return (typeof value === 'string' || typeof value === 'number' || value === null) ? value : null;
    });

    params.push(id); // Add ID for WHERE clause

    const sql = `UPDATE tasks SET ${setClauses} WHERE id = ?`;

    await this.db.run(sql, params); // Use the correctly typed params array
    console.log(`Updated task ${id}.`);

    // Only queue the *requested* updates, not the metadata ones
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
    // Cast the result row to the expected DB row type
    const row = await this.db.get(sql, [id]) as TaskDbRow | null;
    return this.mapRowToTask(row);
  }

  async getAllTasks(): Promise<Task[]> {
    const sql = `SELECT * FROM tasks WHERE is_deleted = 0 ORDER BY created_at DESC`;
    // Cast the result rows to the expected DB row type
    const rows = await this.db.all(sql) as TaskDbRow[];
    return rows.map(row => this.mapRowToTask(row)).filter((task): task is Task => task !== null);
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    const sql = `SELECT * FROM tasks WHERE sync_status = 'pending' OR sync_status = 'error'`;
     // Cast the result rows to the expected DB row type
    const rows = await this.db.all(sql) as TaskDbRow[];
    return rows.map(row => this.mapRowToTask(row)).filter((task): task is Task => task !== null);
  }
}