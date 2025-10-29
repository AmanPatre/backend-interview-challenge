import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../src/db/database';
import { TaskService } from '../src/services/taskService';
import { SyncService } from '../src/services/syncService';
import axios from 'axios';


vi.mock('axios');

describe('SyncService', () => {
  let db: Database;
  let taskService: TaskService;
  let syncService: SyncService;

  beforeEach(async () => {
    db = new Database(':memory:');
    await db.initialize();
    taskService = new TaskService(db);
    syncService = new SyncService(db);
  });

  afterEach(async () => {
    await db.close();
    vi.clearAllMocks();
  });

  describe('checkConnectivity', () => {
    it('should return true when server is reachable', async () => {
      vi.mocked(axios.get).mockResolvedValueOnce({ data: { status: 'ok' } });
      
      const isOnline = await syncService.checkConnectivity();
      expect(isOnline).toBe(true);
    });

    it('should return false when server is unreachable', async () => {
      vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network error'));
      
      const isOnline = await syncService.checkConnectivity();
      expect(isOnline).toBe(false);
    });
  });

  describe('addToSyncQueue', () => {
    it('should add operation to sync queue', async () => {
      const task = await taskService.createTask({ title: 'Test Task' });
      
      //  This test is slightly indirect. We are calling taskService,
      // which should internally call addToSyncQueue.
      // But for this structure, we verify the result.

      // Let's create a *second* operation to be sure
      await taskService.updateTask(task.id, {
        title: 'Updated Title',
      });

      const queueItems = await db.all('SELECT * FROM sync_queue WHERE task_id = ?', [task.id]);
      expect(queueItems.length).toBe(2); 
      expect(queueItems[queueItems.length - 1].operation).toBe('update');
    });
  });

  describe('sync', () => {
    it('should process all items in sync queue', async () => {
      
      const task1 = await taskService.createTask({ title: 'Task 1' });
      const task2 = await taskService.createTask({ title: 'Task 2' });

     
      vi.mocked(axios.post).mockResolvedValueOnce({
        data: {
          processed_items: [
            {
              client_id: task1.id,
              server_id: 'srv_1',
              status: 'success',
            },
            {
              client_id: task2.id,
              server_id: 'srv_2',
              status: 'success',
            },
          ],
        },
      });

      const result = await syncService.sync();
      
      expect(result.success).toBe(true);
      expect(result.synced_items).toBe(2);
      expect(result.failed_items).toBe(0);
    });

    it('should handle sync failures gracefully', async () => {
      const task = await taskService.createTask({ title: 'Task' });

     
      vi.mocked(axios.post).mockRejectedValueOnce(new Error('Network error'));

      const result = await syncService.sync();
      
      expect(result.success).toBe(false);
      
      
      // A graceful failure just adds an error and retries.
      // It doesn't become a "failed_item" until retries are exhausted.
      expect(result.failed_items).toBe(0);
      expect(result.errors.length).toBe(1); // Check that an error was logged
      // -----------------------

      // We can also verify the item is still in the queue with an increased retry
      const queueItem = await db.get('SELECT * FROM sync_queue WHERE task_id = ?', [task.id]);
      expect(queueItem).toBeDefined();
      expect(queueItem.retry_count).toBe(1);
    });
  });

  describe('conflict resolution', () => {
    it('should resolve conflicts using last-write-wins', async () => {
      // This test would verify that when there's a conflict,
      // the task with the more recent updated_at timestamp wins
      // Implementation depends on the actual conflict resolution logic
      // This test is more of a placeholder as the logic is server-side
      // But we can test that a 'conflict' response is handled correctly
      const task1 = await taskService.createTask({ title: 'Task 1' });

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: {
          processed_items: [
            {
              client_id: task1.id,
              server_id: 'srv_1',
              status: 'conflict',
              resolved_data: { title: 'Server wins' }
            },
          ],
        },
      });

      const result = await syncService.sync();
      expect(result.success).toBe(true);
      expect(result.synced_items).toBe(1); 
      
      const updatedTask = await taskService.getTask(task1.id);
      expect(updatedTask?.title).toBe('Server wins');
    });
  });
});