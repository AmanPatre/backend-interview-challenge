import axios, { AxiosError } from 'axios';
import {
  Task,
  SyncQueueItem,
  SyncResult,
  BatchSyncRequest,
  BatchSyncResponse,
  // ProcessedItem // Removed unused import
} from '../types';
import { Database } from '../db/database';

type DbParam = string | number | null;

interface SyncQueueDbItem {
  id: string;
  task_id: string;
  operation: 'create' | 'update' | 'delete';
  data: string;
  created_at: string;
  retry_count: number;
  error_message?: string;
}

export class SyncService {
  private apiUrl: string;
  private batchSize: number;
  private maxRetries: number;

  constructor(
    private db: Database,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api',
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.batchSize = parseInt(process.env.SYNC_BATCH_SIZE || '50', 10);
    this.maxRetries = parseInt(process.env.SYNC_RETRY_ATTEMPTS || '3', 10);
  }

  private mapRowToSyncQueueItem(row: SyncQueueDbItem): SyncQueueItem | null {
    try {
      if (!row || !row.id || !row.task_id || !row.operation || !row.data || !row.created_at) {
          console.error(`Invalid sync queue row data for ID ${row?.id}: Missing essential fields.`);
          return null;
      }
      return {
        id: row.id,
        task_id: row.task_id,
        operation: row.operation,
        data: JSON.parse(row.data),
        created_at: new Date(row.created_at),
        retry_count: row.retry_count,
        error_message: row.error_message,
      };
    } catch (e) {
      console.error(`Failed to parse sync queue item data for ID ${row.id}:`, e);
      return null;
    }
  }


  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      synced_items: 0,
      failed_items: 0,
      errors: [],
    };

    try {
      const queueRows: SyncQueueDbItem[] = await this.db.all(
        `SELECT * FROM sync_queue ORDER BY created_at ASC`,
      );

      if (queueRows.length === 0) {
        console.log('Sync queue is empty.');
        return result;
      }

      const queueItems: SyncQueueItem[] = queueRows
        .map(this.mapRowToSyncQueueItem)
        .filter((item): item is SyncQueueItem => item !== null);

      if (queueItems.length === 0 && queueRows.length > 0) {
         console.warn("Sync queue contained items, but all failed to parse.");
         result.success = false;
         result.errors.push({
             task_id: 'parsing',
             operation: 'sync-init',
             error: 'All sync queue items failed to parse.',
             timestamp: new Date()
         });
         return result;
      }

      for (let i = 0; i < queueItems.length; i += this.batchSize) {
        const batch = queueItems.slice(i, i + this.batchSize);

        await this.updateTaskSyncStatusBatch(
          batch.map((item) => item.task_id),
          'in-progress',
        );

        try {
          console.log(`Processing sync batch ${Math.floor(i / this.batchSize) + 1}...`);
          const response = await this.processBatch(batch);

          if (response.processed_items) {
            for (const processed of response.processed_items) {
              const originalItem = batch.find(
                (item) => item.task_id === processed.client_id,
              );
              if (!originalItem) {
                console.warn(`Received response for unknown client_id: ${processed.client_id} in batch ${Math.floor(i / this.batchSize) + 1}.`);
                continue;
              }

              if (processed.status === 'success') {
                await this.updateSyncStatus(
                  originalItem.id,
                  originalItem.task_id,
                  'synced',
                  processed.server_id,
                  processed.resolved_data,
                );
                result.synced_items++;
              } else if (processed.status === 'conflict') {
                console.warn(`Conflict detected and resolved by server for task ${originalItem.task_id}`);
                await this.updateSyncStatus(
                  originalItem.id,
                  originalItem.task_id,
                  'synced',
                  processed.server_id,
                  processed.resolved_data,
                );
                result.synced_items++;
                result.errors.push({
                  task_id: originalItem.task_id,
                  operation: originalItem.operation,
                  error: `Conflict resolved by server (LWW)`,
                  timestamp: new Date(),
                });
              } else {
                const error = new Error(
                  processed.error || 'Unknown server error',
                );
                await this.handleSyncError(originalItem, error, result);
              }
            }
          } else {
              console.warn(`Batch ${Math.floor(i / this.batchSize) + 1} processed, but server response did not contain 'processed_items'.`);
               result.success = false;
               for (const item of batch) {
                   await this.handleSyncError(
                       item,
                       new Error("Server response missing 'processed_items'"),
                       result
                   );
               }
          }
        } catch (batchError) {
          console.error(`Batch ${Math.floor(i / this.batchSize) + 1} sync failed:`, batchError);
          result.success = false;
          for (const item of batch) {
             const currentStatus = await this.db.get(`SELECT sync_status FROM tasks WHERE id = ?`, [item.task_id]);
             if (currentStatus?.sync_status === 'in-progress') {
                await this.updateTaskSyncStatusBatch([item.task_id], 'error');
             }
            await this.handleSyncError(
              item,
              batchError as Error,
              result,
            );
          }
        }
      }
    } catch (error) {
      console.error('Error during sync process:', error);
      result.success = false;
      result.errors.push({
        task_id: 'general',
        operation: 'sync',
        error: (error as Error).message || 'Unknown sync error',
        timestamp: new Date(),
      });
    }

    if (result.failed_items > 0) {
      result.success = false;
    }

    console.log(`Sync completed. Synced: ${result.synced_items}, Failed: ${result.failed_items}, Errors logged: ${result.errors.length}`);
    return result;
  }

  private generateChecksum(items: SyncQueueItem[]): string {
    if (!items || items.length === 0) return 'empty';
    const firstId = items[0]?.id || 'none';
    const lastId = items[items.length - 1]?.id || 'none';
    const dataString = JSON.stringify(items.map(i => ({ op: i.operation, tid: i.task_id })));
    let hash = 0;
    for (let i = 0; i < dataString.length; i++) {
        hash = (hash << 5) - hash + dataString.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return `${items.length}-${firstId}-${lastId}-${hash}`;
  }

  private async processBatch(
    items: SyncQueueItem[],
  ): Promise<BatchSyncResponse> {
    console.log(`Sending batch of ${items.length} items to server.`);
    const requestPayload: BatchSyncRequest = {
      items: items,
      client_timestamp: new Date(),
      checksum: this.generateChecksum(items), // Correctly uses optional property
    };

    try {
      const response = await axios.post<BatchSyncResponse>(
        `${this.apiUrl}/batch`,
        requestPayload,
        { timeout: 15000 },
      );

      console.log('Received batch response from server.');
      if (!response.data || !Array.isArray(response.data.processed_items)) {
          throw new Error("Invalid batch response structure from server.");
      }
      return response.data;
    } catch (error) {
      console.error('Error sending batch to server:', error);
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        if (axiosError.response) {
          console.error('Server responded with status:', axiosError.response.status);
          console.error('Response data:', axiosError.response.data);
        } else if (axiosError.request) {
          console.error('No response received from server.');
        } else {
          console.error('Error setting up request:', axiosError.message);
        }
      }
      throw new Error(`Failed to process batch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async updateSyncStatus(
    queueItemId: string,
    taskId: string,
    status: 'synced' | 'failed',
    serverId?: string,
    resolvedData?: Partial<Task>,
  ): Promise<void> {
    console.log(`Updating task ${taskId} status to ${status} (queue item: ${queueItemId}).`);
    const now = new Date();
    let setClauses: string[] = [];
    let params: (DbParam | undefined)[] = [];

    setClauses.push('sync_status = ?');
    params.push(status);

    if (status === 'synced') {
        setClauses.push('last_synced_at = ?');
        params.push(now.toISOString());
    }

    if (resolvedData && status === 'synced') {
        const updatesFromResolved: { [key: string]: DbParam } = {};
        for (const [key, value] of Object.entries(resolvedData)) {
            // Only include fields relevant to the Task model
            if (value !== undefined && ['title', 'description', 'completed', 'is_deleted', 'updated_at', 'server_id', 'id'].includes(key)) {
                if (value instanceof Date) {
                    updatesFromResolved[key] = value.toISOString();
                } else if (typeof value === 'boolean') {
                    updatesFromResolved[key] = value ? 1 : 0;
                } else if (typeof value === 'string' || typeof value === 'number' || value === null) {
                    updatesFromResolved[key] = value;
                }
            }
        }

         updatesFromResolved['updated_at'] = resolvedData.updated_at ? new Date(resolvedData.updated_at).toISOString() : now.toISOString();

        const finalServerId = serverId || resolvedData.server_id || resolvedData.id;
        if(finalServerId) {
            updatesFromResolved['server_id'] = finalServerId;
        }

        for (const [key, value] of Object.entries(updatesFromResolved)) {
            if (!setClauses.some(clause => clause.startsWith(key + ' ='))) {
                 if(key !== 'id') {
                    setClauses.push(`${key} = ?`);
                    params.push(value);
                 }
            }
        }
    } else if (serverId && !setClauses.some(clause => clause.startsWith('server_id ='))) {
         setClauses.push('server_id = ?');
         params.push(serverId);
    }

    // Filter out undefined before adding taskId
    const definedParams = params.filter(p => p !== undefined);
    definedParams.push(taskId);

    if (setClauses.length > 0) {
        const updateTaskSql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`;
        try {
            // Final type assertion for db.run
            const finalParams: DbParam[] = definedParams as DbParam[];
            await this.db.run(updateTaskSql, finalParams);
        } catch (updateError) {
             console.error(`Failed to update task ${taskId} status to ${status}:`, updateError);
        }
    }

    const deleteQueueSql = `DELETE FROM sync_queue WHERE id = ?`;
    try {
        await this.db.run(deleteQueueSql, [queueItemId]);
        console.log(`Removed item ${queueItemId} from sync queue.`);
    } catch (deleteError) {
        console.error(`Failed to remove item ${queueItemId} from sync queue:`, deleteError);
    }
  }


  private async updateTaskSyncStatusBatch(
    taskIds: string[],
    status: 'pending' | 'in-progress' | 'error' | 'synced' | 'failed',
  ): Promise<void> {
    if (!taskIds || taskIds.length === 0) return;
    const placeholders = taskIds.map(() => '?').join(',');
    const sql = `UPDATE tasks SET sync_status = ? WHERE id IN (${placeholders})`;
    try {
        await this.db.run(sql, [status, ...taskIds]);
    } catch (batchUpdateError) {
        console.error(`Failed to batch update status to ${status} for tasks ${taskIds.join(',')}:`, batchUpdateError);
    }
  }

  private async handleSyncError(
    item: SyncQueueItem,
    error: Error,
    result: SyncResult,
  ): Promise<void> {
    const newRetryCount = item.retry_count + 1;
    const errorMessage = error.message || 'Unknown sync error';
    console.error(
      `Sync failed for task ${item.task_id} (Item ID: ${item.id}, Attempt ${newRetryCount}/${this.maxRetries}): ${errorMessage}`,
    );

    if (newRetryCount > this.maxRetries) {
      console.error(`Max retries exceeded for task ${item.task_id}. Marking as failed.`);
      await this.updateSyncStatus(item.id, item.task_id, 'failed', undefined, undefined);
      result.failed_items++;
      result.errors.push({
        task_id: item.task_id,
        operation: item.operation,
        error: `Permanent failure after ${this.maxRetries} retries: ${errorMessage}`,
        timestamp: new Date(),
      });
    } else {
      const currentStatusRow = await this.db.get(`SELECT sync_status FROM tasks WHERE id = ?`, [item.task_id]);
      if (currentStatusRow?.sync_status !== 'failed') { // Avoid overwriting 'failed' with 'error'
          await this.updateTaskSyncStatusBatch([item.task_id], 'error');
      }
      const updateQueueSql = `
        UPDATE sync_queue
        SET retry_count = ?, error_message = ?
        WHERE id = ?
      `;
      try {
        await this.db.run(updateQueueSql, [newRetryCount, errorMessage, item.id]);
      } catch (queueUpdateError) {
           console.error(`Failed to update retry count for queue item ${item.id}:`, queueUpdateError);
      }
       result.errors.push({
        task_id: item.task_id,
        operation: item.operation,
        error: `Temporary failure (attempt ${newRetryCount}): ${errorMessage}`,
        timestamp: new Date(),
      });
    }
  }

  async checkConnectivity(): Promise<boolean> {
    try {
      await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      console.log('Connectivity check: Server is reachable.');
      return true;
    } catch (error) {
       // Log only the error message if it's an Error instance
      const message = error instanceof Error ? error.message : String(error);
      console.warn('Connectivity check: Server is unreachable.', message);
      return false;
    }
  }
}

