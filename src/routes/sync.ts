import { Router, Request, Response, NextFunction } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  router.post('/sync', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const isOnline = await syncService.checkConnectivity();
      if (!isOnline) {
        return res.status(503).json({
          error: 'Service Unavailable: Cannot sync while offline.',
          timestamp: new Date().toISOString(),
          path: req.path,
        });
      }

      const syncResult = await syncService.sync();
      res.status(200).json(syncResult);
    } catch (error) {
      next(error);
    }
  });

  router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pendingCountResult = await db.get(
        `SELECT COUNT(*) as count FROM sync_queue`,
      );
      const pendingSyncCount = pendingCountResult?.count || 0;

      const lastSyncedTask = await db.get(
        `SELECT MAX(last_synced_at) as last_sync_timestamp FROM tasks WHERE sync_status = 'synced'`,
      );
      const lastSyncTimestamp = lastSyncedTask?.last_sync_timestamp || null;

      const isOnline = await syncService.checkConnectivity();
      const syncQueueSize = pendingSyncCount;

      res.status(200).json({
        pending_sync_count: pendingSyncCount,
        last_sync_timestamp: lastSyncTimestamp,
        is_online: isOnline,
        sync_queue_size: syncQueueSize,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/batch', async (req: Request, res: Response, next: NextFunction) => {
    console.log('Received POST /batch request (Server Simulation)');

    const items = req.body.items || [];
    const processed_items: any[] = items.map((item: any) => ({
      client_id: item.task_id,
      server_id: `srv_${item.task_id.substring(0, 6)}`,
      status: 'success',
    }));

    res.status(200).json({ processed_items });
  });

  router.get('/health', async (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date() });
  });

  return router;
}

