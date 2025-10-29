import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../src/db/database';
import { TaskService } from '../src/services/taskService';
import { Task } from '../src/types';

describe('TaskService', () => {
  let db: Database;
  let taskService: TaskService;

  beforeEach(async () => {
    db = new Database(':memory:');
    await db.initialize();
    taskService = new TaskService(db);
  });

  afterEach(async () => {
    await db.close();
  });

  describe('createTask', () => {
    it('should create a new task with default values', async () => {
      const taskData = {
        title: 'Test Task',
        description: 'Test Description',
      };

      const task = await taskService.createTask(taskData);

      expect(task).toBeDefined();
      expect(task.id).toBeDefined();
      expect(task.title).toBe('Test Task');
      expect(task.description).toBe('Test Description');
      expect(task.completed).toBe(false);
      expect(task.is_deleted).toBe(false);
      expect(task.sync_status).toBe('pending');
    });

    it('should add task to sync queue after creation', async () => {
      const taskData = {
        title: 'Test Task',
      };

      const task = await taskService.createTask(taskData);
      
      
      const syncQueue = await db.all('SELECT * FROM sync_queue WHERE task_id = ?', [task.id]);
      expect(syncQueue.length).toBe(1);
      expect(syncQueue[0].operation).toBe('create');
    });
  });

  describe('updateTask', () => {
    it('should update an existing task', async () => {
      
      const task = await taskService.createTask({ title: 'Original Title' });
      
      
      const updated = await taskService.updateTask(task.id, {
        title: 'Updated Title',
        completed: true,
      });

      expect(updated).toBeDefined();
      expect(updated?.title).toBe('Updated Title');
      expect(updated?.completed).toBe(true);
      expect(updated?.sync_status).toBe('pending');
    });

    it('should return null for non-existent task', async () => {
      const result = await taskService.updateTask('non-existent-id', { title: 'Test' });
      expect(result).toBeNull();
    });
  });

  describe('deleteTask', () => {
    it('should soft delete a task', async () => {
      const task = await taskService.createTask({ title: 'To Delete' });
      
      const result = await taskService.deleteTask(task.id);
      expect(result).toBe(true);

      
      const deleted = await db.get('SELECT * FROM tasks WHERE id = ?', [task.id]);
      expect(deleted.is_deleted).toBe(1);
      expect(deleted.sync_status).toBe('pending');
    });

    it('should return false for non-existent task', async () => {
      const result = await taskService.deleteTask('non-existent-id');
      expect(result).toBe(false);
    });
  });

  describe('getAllTasks', () => {
    it('should return only non-deleted tasks', async () => {
     
      await taskService.createTask({ title: 'Task 1' });
      await taskService.createTask({ title: 'Task 2' });
      const toDelete = await taskService.createTask({ title: 'Task 3' });
      
      
      await taskService.deleteTask(toDelete.id);

      const tasks = await taskService.getAllTasks();
      expect(tasks.length).toBe(2);
      expect(tasks.find(t => t.title === 'Task 3')).toBeUndefined();
    });
  });

  describe('getTasksNeedingSync', () => {
    it('should return tasks with pending or error sync status', async () => {
      
      const task1 = await taskService.createTask({ title: 'Pending Task' });
      const task2 = await taskService.createTask({ title: 'Another Pending' });
      
      
      await db.run('UPDATE tasks SET sync_status = ? WHERE id = ?', ['synced', task2.id]);

      const needingSync = await taskService.getTasksNeedingSync();
      expect(needingSync.length).toBe(1);
      expect(needingSync[0].id).toBe(task1.id);
    });
  });
});