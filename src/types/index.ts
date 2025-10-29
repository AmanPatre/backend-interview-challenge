export interface Task {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  created_at: Date;
  updated_at: Date;
  is_deleted: boolean;
  sync_status?: 'pending' | 'synced' | 'error' | 'in-progress' | 'failed';
  server_id?: string;
  last_synced_at?: Date | null; // Correct type: Allow Date or null
}

export interface SyncQueueItem {
  id: string;
  task_id: string;
  operation: 'create' | 'update' | 'delete';
  data: Partial<Task>;
  created_at: Date;
  retry_count: number;
  error_message?: string;
}

export interface SyncResult {
  success: boolean;
  synced_items: number;
  failed_items: number;
  errors: SyncError[];
}

export interface SyncError {
  task_id: string;
  operation: string;
  error: string;
  timestamp: Date;
}

// Keep this interface for clarity in BatchSyncResponse
export interface ProcessedItem {
    client_id: string;
    server_id?: string;
    status: 'success' | 'conflict' | 'error';
    resolved_data?: Partial<Task>;
    error?: string;
}

export interface BatchSyncRequest {
  items: SyncQueueItem[];
  client_timestamp: Date;
  checksum?: string; // Ensure checksum is optional here (matches usage)
}

export interface BatchSyncResponse {
  processed_items: ProcessedItem[];
}

