import { Router, Request, Response, NextFunction } from 'express';
import { SyncService } from '../services/syncService';
import { Database } from '../db/database';
import { SyncQueueItem } from '../types';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const syncService = new SyncService(db);

  router.post('/sync', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const isOnline = await syncService.checkConnectivity();
      if (!isOnline) {
        return res.status(503).json({ // Added return
          error: 'Service Unavailable: Cannot sync while offline.',
          timestamp: new Date().toISOString(),
          path: req.path,
        });
      }

      const syncResult = await syncService.sync();
      res.status(200).json(syncResult); // Ensure response is sent
    } catch (error) {
      next(error); // Pass error if sync fails
    }
  });

  router.get('/status', async (
     _: Request,
     res: Response,
     next: NextFunction
   ) => {
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

  router.post('/batch', async (req: Request, res: Response ) => {
    console.log('Received POST /batch request (Server Simulation)');
    console.log('Batch Checksum:', req.body.checksum);

    const items: SyncQueueItem[] = req.body.items || [];
    const processed_items: any[] = items.map((item: SyncQueueItem) => ({
      client_id: item.task_id,
      server_id: `srv_${item.task_id.substring(0, 6)}`,
      status: 'success',
      resolved_data: item.operation !== 'delete' ? {
          ...item.data,
          id: `srv_${item.task_id.substring(0, 6)}`,
          server_id: `srv_${item.task_id.substring(0, 6)}`,
          updated_at: new Date().toISOString()
       } : undefined
    }));

     if (processed_items.length > 1 && items[1]?.operation === 'update') {
        processed_items[1].status = 'conflict';
        processed_items[1].resolved_data = {
            ...(items[1].data),
            id: processed_items[1].server_id,
            server_id: processed_items[1].server_id,
            title: "Server Title Wins Conflict",
            description: items[1].data.description || "Server added description",
            completed: items[1].data.completed,
            updated_at: new Date(Date.now() + 1000).toISOString()
        };
        console.log(`Simulating conflict resolution for task ${items[1].task_id}`);
     }

    res.status(200).json({ processed_items });
  });

  router.get('/health', async (
     _: Request,
     res: Response
  ) => {
    res.json({ status: 'ok', timestamp: new Date() });
  });

  return router;
}

