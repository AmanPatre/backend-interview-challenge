import axios, { AxiosError } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  Task,
  SyncQueueItem,
  SyncResult,
  BatchSyncRequest,
  BatchSyncResponse,
  SyncError,
} from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';
import { CHALLENGE_CONSTRAINTS } from '../utils/challenge-constraints';

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
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api',
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.batchSize = parseInt(process.env.SYNC_BATCH_SIZE || '50', 10);
    this.maxRetries = parseInt(process.env.SYNC_RETRY_ATTEMPTS || '3', 10);
  }

  private mapRowToSyncQueueItem(row: SyncQueueDbItem): SyncQueueItem {
    try {
      return {
        ...row,
        data: JSON.parse(row.data),
        created_at: new Date(row.created_at),
      };
    } catch (e) {
      console.error(`Failed to parse sync queue item data for ID ${row.id}:`, e);
      return {
        ...row,
        data: { error: 'Failed to parse data', originalData: row.data },
        created_at: new Date(row.created_at),
        error_message: `Failed to parse item data: ${e}`,
      };
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

      const queueItems = queueRows.map(this.mapRowToSyncQueueItem);

      for (let i = 0; i < queueItems.length; i += this.batchSize) {
        const batch = queueItems.slice(i, i + this.batchSize);

        await this.updateTaskSyncStatusBatch(
          batch.map((item) => item.task_id),
          'in-progress',
        );

        try {
          console.log(`Processing sync batch ${i / this.batchSize + 1}...`);
          const response = await this.processBatch(batch);

          if (response.processed_items) {
            for (const processed of response.processed_items) {
              const originalItem = batch.find(
                (item) => item.task_id === processed.client_id,
              );
              if (!originalItem) {
                console.warn(`Received response for unknown client_id: ${processed.client_id}`);
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
          }
        } catch (batchError) {
          console.error('Batch sync failed:', batchError);
          result.success = false;
          for (const item of batch) {
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

    console.log(`Sync completed. Synced: ${result.synced_items}, Failed: ${result.failed_items}`);
    return result;
  }


  private generateChecksum(items: SyncQueueItem[]): string {
    if (!items || items.length === 0) return 'empty';
    const firstId = items[0]?.id || 'none';
    const lastId = items[items.length - 1]?.id || 'none';
    return `${items.length}-${firstId}-${lastId}`;
  }

  private async processBatch(
    items: SyncQueueItem[],
  ): Promise<BatchSyncResponse> {
    console.log(`Sending batch of ${items.length} items to server.`);
    const requestPayload: BatchSyncRequest = {
      items: items,
      client_timestamp: new Date(),
      checksum: this.generateChecksum(items),
    };

    try {
      const response = await axios.post<BatchSyncResponse>(
        `${this.apiUrl}/batch`,
        requestPayload,
        { timeout: 15000 },
      );

      console.log('Received batch response from server.');
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
      throw error;
    }
  }

  private async resolveConflict(
    localTask: Task,
    serverTask: Partial<Task>,
  ): Promise<Task> {
    console.log(`Resolving conflict for task ${localTask.id} using Last-Write-Wins.`);
    const localUpdate = localTask.updated_at;
    const serverUpdate = serverTask.updated_at
      ? new Date(serverTask.updated_at)
      : new Date(0);

    if (localUpdate >= serverUpdate) {
      console.log(`Conflict resolution: Local version wins (updated: ${localUpdate.toISOString()})`);
      return localTask;
    } else {
      console.log(`Conflict resolution: Server version wins (updated: ${serverUpdate.toISOString()})`);
      const resolvedTask = { ...localTask, ...serverTask };
      resolvedTask.created_at = new Date(resolvedTask.created_at);
      resolvedTask.updated_at = new Date(resolvedTask.updated_at);
      resolvedTask.last_synced_at = serverTask.last_synced_at ? new Date(serverTask.last_synced_at) : new Date();
      return resolvedTask as Task;
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
    let setClauses = ['sync_status = ?', 'last_synced_at = ?'];
    let params: (string | number | null | Date)[] = [status, now.toISOString()];

    if (serverId) {
      setClauses.push('server_id = ?');
      params.push(serverId);
    }

    if (resolvedData && status === 'synced') {
        const updatesFromResolved = {
            title: resolvedData.title,
            description: resolvedData.description,
            completed: resolvedData.completed,
            is_deleted: resolvedData.is_deleted,
            updated_at: resolvedData.updated_at ? new Date(resolvedData.updated_at).toISOString() : now.toISOString(),
            server_id: serverId || resolvedData.server_id || resolvedData.id,
        };
        for (const [key, value] of Object.entries(updatesFromResolved)) {
            if (value !== undefined) {
                 const dbValue = typeof value === 'boolean' ? (value ? 1 : 0) : value;
                 setClauses.push(`${key} = ?`);
                 params.push(dbValue);
            }
        }
        if (!updatesFromResolved.server_id && serverId) {
             setClauses.push('server_id = ?');
             params.push(serverId);
        }
    }

    params.push(taskId);

    const updateTaskSql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`;
    await this.db.run(updateTaskSql, params);

    const deleteQueueSql = `DELETE FROM sync_queue WHERE id = ?`;
    await this.db.run(deleteQueueSql, [queueItemId]);
    console.log(`Removed item ${queueItemId} from sync queue.`);
  }

  private async updateTaskSyncStatusBatch(
    taskIds: string[],
    status: 'pending' | 'in-progress' | 'error',
  ): Promise<void> {
    if (taskIds.length === 0) return;
    const placeholders = taskIds.map(() => '?').join(',');
    const sql = `UPDATE tasks SET sync_status = ? WHERE id IN (${placeholders})`;
    await this.db.run(sql, [status, ...taskIds]);
  }

  private async handleSyncError(
    item: SyncQueueItem,
    error: Error,
    result: SyncResult,
  ): Promise<void> {
    const newRetryCount = item.retry_count + 1;
    const errorMessage = error.message || 'Unknown sync error';
    console.error(
      `Sync failed for task ${item.task_id} (Attempt ${newRetryCount}/${this.maxRetries}): ${errorMessage}`,
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
       await this.updateTaskSyncStatusBatch([item.task_id], 'error');
      const updateQueueSql = `
        UPDATE sync_queue
        SET retry_count = ?, error_message = ?
        WHERE id = ?
      `;
      await this.db.run(updateQueueSql, [newRetryCount, errorMessage, item.id]);
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
      console.warn('Connectivity check: Server is unreachable.', error instanceof Error ? error.message : error);
      return false;
    }
  }
}

