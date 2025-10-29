import { v4 as uuidv4 } from 'uuid';
import { Task, SyncQueueItem } from '../types';
import { Database } from '../db/database';

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
      // Correctly return null if DB value is null/undefined
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : null,
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

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existingTask = await this.getTask(id);
    if (!existingTask) {
      console.log(`Update failed: Task ${id} not found or deleted.`);
      return null;
    }

    const now = new Date();
    const updatesWithTimestamp = {
      ...updates,
      updated_at: now.toISOString(),
      sync_status: 'pending',
    };

    const fields = Object.keys(updatesWithTimestamp);
    const validFields = fields.filter(field => updatesWithTimestamp[field as keyof typeof updatesWithTimestamp] !== undefined);
    if (validFields.length === 0) {
        console.log("No valid fields provided for update.");
        return existingTask;
    }

    const setClauses = validFields
      .map((field ) => {
          const columnName = field;
          return `${columnName} = ?`;
      })
      .join(', ');

    const params = validFields.map(field => {
        const value = updatesWithTimestamp[field as keyof typeof updatesWithTimestamp];
        return typeof value === 'boolean' ? (value ? 1 : 0) : value;
    });

    params.push(id);

    const sql = `UPDATE tasks SET ${setClauses} WHERE id = ?`;
    // Ensure params only contain types suitable for DB
    const finalParams: (string | number | null)[] = params.map(p => (p === undefined ? null : p));
    await this.db.run(sql, finalParams);
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

