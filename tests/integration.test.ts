import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../src/db/database';
import { TaskService } from '../src/services/taskService';
import { SyncService } from '../src/services/syncService';
import axios from 'axios';


vi.mock('axios');

describe('Integration Tests', () => {
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

  describe('Offline to Online Sync Flow', () => {
    it('should handle complete offline to online workflow', async () => {
     
      vi.mocked(axios.get).mockResolvedValue({ data: { status: 'ok' } });
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          processed_items: [
           
            { client_id: 'id-1', server_id: 'srv-1', status: 'success' },
            { client_id: 'id-2', server_id: 'srv-1', status: 'success' },
            { client_id: 'id-3', server_id: 'srv-3', status: 'success' },
            { client_id: 'id-4', server_id: 'srv-3', status: 'success' },
          ]
        }
      });


      
      const task1 = await taskService.createTask({
        title: 'Offline Task 1',
        description: 'Created while offline',
      });

    
      await taskService.updateTask(task1.id, {
        completed: true,
      });

      
      const task2 = await taskService.createTask({
        title: 'Offline Task 2',
      });

     
      await taskService.deleteTask(task2.id);

      
      const queueItems = await db.all('SELECT * FROM sync_queue ORDER BY created_at');
      expect(queueItems.length).toBe(4); 
      
      
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          processed_items: [
            { client_id: queueItems[0].task_id, server_id: 'srv-1', status: 'success' },
            { client_id: queueItems[1].task_id, server_id: 'srv-1', status: 'success' },
            { client_id: queueItems[2].task_id, server_id: 'srv-2', status: 'success' },
            { client_id: queueItems[3].task_id, server_id: 'srv-2', status: 'success' },
          ]
        }
      });

     
      const isOnline = await syncService.checkConnectivity();
      expect(isOnline).toBe(true);

      if (isOnline) {
        const syncResult = await syncService.sync();
        
        
        expect(syncResult).toBeDefined();
        expect(syncResult.success).toBe(true);
        expect(syncResult.synced_items).toBe(4);
        expect(syncResult.failed_items).toBe(0);

        
        const queueAfter = await db.all('SELECT * FROM sync_queue');
        expect(queueAfter.length).toBe(0);
      }
    });
  });

  describe('Conflict Resolution Scenario', () => {
    it('should handle task edited on multiple devices', async () => {
      
      vi.mocked(axios.get).mockResolvedValue({ data: { status: 'ok' } });

      
      const task = await taskService.createTask({
        title: 'Shared Task',
        description: 'Task on multiple devices',
      });
  
      await db.run('DELETE FROM sync_queue');

      
      await taskService.updateTask(task.id, {
        title: 'Local Update',
        completed: true,
      });

     
      vi.mocked(axios.post).mockResolvedValueOnce({
        data: {
          processed_items: [
            {
              client_id: task.id,
              server_id: 'srv-shared',
              status: 'conflict',
              resolved_data: {
                title: 'Server Title Wins',
                description: 'Server description wins',
                updated_at: new Date(Date.now() + 1000) 
              }
            }
          ]
        }
      });
      
      const syncResult = await syncService.sync();
      expect(syncResult.success).toBe(true);
      expect(syncResult.synced_items).toBe(1);

      
      const resolvedTask = await taskService.getTask(task.id);
      expect(resolvedTask?.title).toBe('Server Title Wins');
      expect(resolvedTask?.description).toBe('Server description wins');
    });
  });

  describe('Error Recovery', () => {
    it('should retry failed sync operations', async () => {
  
      vi.mocked(axios.get).mockResolvedValue({ data: { status: 'ok' } });

     
      const task = await taskService.createTask({
        title: 'Task to Sync',
      });

      
      vi.mocked(axios.post).mockRejectedValueOnce(new Error('Network Error 503'));
      
      const result1 = await syncService.sync();
      expect(result1.success).toBe(false);
      expect(result1.failed_items).toBe(0); 
      expect(result1.errors.length).toBe(1);
      
      
      let queueItem = await db.get('SELECT * FROM sync_queue WHERE task_id = ?', [task.id]);
      expect(queueItem.retry_count).toBe(1);
      let dbTask = await taskService.getTask(task.id);
      expect(dbTask?.sync_status).toBe('error');

     
      vi.mocked(axios.post).mockResolvedValueOnce({
        data: {
          processed_items: [
            { client_id: task.id, server_id: 'srv-retry', status: 'success' }
          ]
        }
      });

      const result2 = await syncService.sync();
      expect(result2.success).toBe(true);
      expect(result2.synced_items).toBe(1);

     
      queueItem = await db.get('SELECT * FROM sync_queue WHERE task_id = ?', [task.id]);
      expect(queueItem).toBeUndefined();
      dbTask = await taskService.getTask(task.id);
      expect(dbTask?.sync_status).toBe('synced');
    });
  });
});