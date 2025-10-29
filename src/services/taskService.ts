import { v4 as uuidv4 } from 'uuid';
import { Task, SyncQueueItem } from '../types';
import { Database } from '../db/database';

export class TaskService {
  constructor(private db: Database) {}

  
  private mapRowToTask(row: any): Task {
    return {
      ...row,
      completed: !!row.completed,
      is_deleted: !!row.is_deleted,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : null,
    };
  }

 
  private async addToSyncQueue(
    taskId: string,
    operation: 'create' | 'update' | 'delete',
    data: Partial<Task>,
  ): Promise<void> {
    const queueItem: SyncQueueItem = {
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
      last_synced_at: undefined,
    };

    
    const sql = `
      INSERT INTO tasks (
        id, title, description, completed, created_at, updated_at, 
        is_deleted, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
    ]);

    
    await this.addToSyncQueue(newTask.id, 'create', newTask);

    return newTask;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    
    const existingTask = await this.getTask(id);
    if (!existingTask) {
      return null;
    }

    
    const now = new Date();
    const updatesWithTimestamp = {
      ...updates,
      updated_at: now.toISOString(),
      sync_status: 'pending',
    };

    
    const fields = Object.keys(updatesWithTimestamp);
    const values = Object.values(updatesWithTimestamp);
    const setClause = fields
      .map((field) => {
        
        if (field === 'completed' || field === 'is_deleted') {
          return `${field} = ?`;
        }
        return `${field} = ?`;
      })
      .join(', ');

    const dbValues = values.map((val) =>
      typeof val === 'boolean' ? (val ? 1 : 0) : val,
    );

   
    const sql = `UPDATE tasks SET ${setClause} WHERE id = ?`;
    await this.db.run(sql, [...dbValues, id]);

   
    await this.addToSyncQueue(id, 'update', updates);

    
    return this.getTask(id);
  }

  async deleteTask(id: string): Promise<boolean> {
    
    const existingTask = await this.getTask(id);
    if (!existingTask) {
      return false;
    }

    const now = new Date();
    const sql = `
      UPDATE tasks 
      SET is_deleted = 1, updated_at = ?, sync_status = 'pending' 
      WHERE id = ?
    `;
    await this.db.run(sql, [now.toISOString(), id]);

    
    await this.addToSyncQueue(id, 'delete', { id }); 

    return true;
  }

  async getTask(id: string): Promise<Task | null> {
    
    const sql = `SELECT * FROM tasks WHERE id = ? AND is_deleted = 0`;
    const row = await this.db.get(sql, [id]);

  
    if (!row) {
      return null;
    }
    return this.mapRowToTask(row);
  }

  async getAllTasks(): Promise<Task[]> {
    
    const sql = `SELECT * FROM tasks WHERE is_deleted = 0`;
    const rows = await this.db.all(sql);

  
    return rows.map(this.mapRowToTask);
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    
    const sql = `SELECT * FROM tasks WHERE sync_status = 'pending' OR sync_status = 'error'`;
    const rows = await this.db.all(sql);
    return rows.map(this.mapRowToTask);
  }
}
