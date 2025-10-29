import { Router, Request, Response, NextFunction } from 'express';
import { SyncService } from '../services/syncService';
import { Database } from '../db/database';
import { SyncQueueItem, ProcessedItem } from '../types';

// Creates and configures the Express Router for sync endpoints.
export function createSyncRouter(db: Database): Router {
  const router = Router();
  const syncService = new SyncService(db);

  //  Triggers the client's sync process.
  router.post('/sync', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const isOnline = await syncService.checkConnectivity();
      if (!isOnline) return res.status(503).json({ error: 'Cannot sync while offline.' });
      const syncResult = await syncService.sync();
      return res.status(200).json(syncResult);
    } catch (error) { next(error); return; }
  });

  //  Gets local sync status information.
  router.get('/status', async (_: Request, res: Response, next: NextFunction) => {
    try {
      const pendingCountResult = await db.get(`SELECT COUNT(*) as count FROM sync_queue`);
      const pendingSyncCount = pendingCountResult?.count || 0;
      const lastSyncedTask = await db.get(`SELECT MAX(last_synced_at) as last_sync FROM tasks WHERE sync_status = 'synced'`);
      const lastSyncTimestamp = lastSyncedTask?.last_sync || null;
      const isOnline = await syncService.checkConnectivity();
      return res.status(200).json({
        pending_sync_count: pendingSyncCount,
        last_sync_timestamp: lastSyncTimestamp,
        is_online: isOnline,
        sync_queue_size: pendingSyncCount,
      });
    } catch (error) { next(error); return; }
  });

  //  SIMULATED server endpoint to receive sync batches.
  router.post('/batch', async (req: Request, res: Response ) => {
    
    console.log('Received POST /batch request (Server Simulation)');
    console.log('Batch Checksum:', req.body.checksum); 
    const items: SyncQueueItem[] = req.body.items || [];
    
    const processed_items: ProcessedItem[] = items.map((item: SyncQueueItem): ProcessedItem => {
        const serverId = `srv_${item.task_id.substring(0, 6)}`; 
        return {
            client_id: item.task_id, server_id: serverId, status: 'success', 
          
            resolved_data: item.operation !== 'delete' ? { ...item.data, id: serverId, server_id: serverId, updated_at: new Date() } : undefined
        };
    });
     // Simple logic to simulate a conflict for demonstration.
     if (processed_items.length > 1 && items[1]?.operation === 'update') {
        processed_items[1].status = 'conflict';
       
        processed_items[1].resolved_data = {
            ...(items[1].data), id: processed_items[1].server_id, server_id: processed_items[1].server_id,
            title: "Server Title Wins Conflict", description: items[1].data.description || "Server added description",
            updated_at: new Date(Date.now() + 1000) 
        };
        console.log(`Simulating conflict resolution for task ${items[1].task_id}`);
     }
    return res.status(200).json({ processed_items }); 
  });

  //  Simple health check endpoint.
  router.get('/health', async (_: Request, res: Response) => {
    return res.json({ status: 'ok', timestamp: new Date() }); 
  });

  return router;
}