
# Backend Interview Challenge - Task Sync API (Solution)

This repository contains the completed solution for the Backend Developer Interview Challenge. The project implements a sync-enabled task management API using Node.js, Express, and SQLite, with a focus on offline-first capabilities, batch synchronization, and conflict resolution.

## Features Implemented

* **Full Task CRUD API**: All endpoints (GET, POST, PUT, DELETE) for managing tasks are implemented.

* **Offline-First Sync Queue**: All create, update, and delete operations are added to a persistent SQLite sync_queue table, allowing the app to function offline.

* **Batch Synchronization**: When online, the client syncs all pending operations in batches (size configurable via .env) to a remote server.

* **Conflict Resolution Handling** : The client gracefully handles conflict responses from the server, applying the server's "last-write-wins" resolved data to the local database.

* **Retry Logic & Error Handling** : Failed sync operations are retried up to 3 times (SYNC_RETRY_ATTEMPTS). After exhausting retries, tasks are marked as failed.

* **Connectivity Check** : A dedicated /api/health endpoint is used to check for server connectivity before attempting a sync.

* **Robust Typing** : The project is fully typed using TypeScript, with interfaces for all data models (Task, SyncQueueItem, etc.).

## API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/tasks` | Get all non-deleted tasks. |
| `GET` | `/tasks/:id` | Get a single task by its ID. |
| `POST` | `/tasks` | Create a new task. Adds to sync queue. |
| `PUT` | `/tasks/:id` | Update an existing task. Adds to sync queue. |
| `DELETE` | `/tasks/:id` | Soft-delete a task. Adds to sync queue. |
| `POST` | `/sync` | **(Client)** Triggers the client to sync its queue with the server. |
| `GET` | `/status` | **(Client)** Gets the local sync queue status (pending items, last sync). |
| `GET` | `/health` | **(Server Sim)** A health check endpoint to check connectivity. |
| `POST` | `/batch` | **(Server Sim)** The simulated server endpoint that receives sync batches from the client. |

## Core Implementation Approach
The application is designed as an offline-first client that communicates with a (simulated) remote server.

1. **src/services/taskService.ts**

   This service handles all direct interactions with the tasks table in the local SQLite database.
createTask, updateTask, deleteTask: These methods perform the local database operation (create, update, or soft-delete).

   * **Sync Queue Integration**: After successfully modifying the local database, each of these methods calls addToSyncQueue. This creates a new record in the sync_queue table with the operation type (create, update, delete) and the relevant task data.

   * **sync_status**: All local changes set the task's sync_status to 'pending'.

2. **src/services/syncService.ts**
This service is the orchestrator for the entire synchronization process.
   * checkConnectivity(): Before any sync, this method pings the /api/health endpoint to ensure the server is reachable.

   * sync(): This is the main function, triggered by the POST /api/sync endpoint.
   1. It queries the sync_queue table for all pending operations, ordered by creation time to ensure chronological processing.
   2. It loops through the items in batches (size defined by SYNC_BATCH_SIZE).
   3. Before sending a batch, it updates the sync_status of the relevant tasks to 'in-progress'.
   4. It calls processBatch to send the batch to the server.
   5. It handles the response from processBatch, updating tasks or handling errors.



3. **Sync Logic and Conflict Resolution**
   * **Batch Processing**: The processBatch method builds the BatchSyncRequest payload. This includes a checksum of the items, as required by the challenge constraints. It then POSTs this payload to the /api/batch endpoint.

   * **Handling Responses**: The service processes the BatchSyncResponse from the server.

   * **On status**: 'success': The updateSyncStatus method is called. This updates the local task's server_id and last_synced_at, sets sync_status to 'synced', and deletes the item from the sync_queue.

   * **On status**: 'conflict': This simulates the server's "last-write-wins" resolution. The SyncService respects the server's decision by taking the resolved_data from the response and using it to overwrite the local task data. The item is then treated as successfully synced and removed from the queue.

4. **Error Handling and Retries**
   * **API Errors**: All Express routes are wrapped in try...catch blocks that forward errors to the errorHandler middleware, which sends a standardized JSON error response.

   * **Sync Errors**: If processBatch fails (e.g., network error, 500 status), the handleSyncError method is triggered for each item in that batch.

   1. The retry_count for the queue item is incremented, and the task's sync_status is set to 'error'.

   2. If the retry_count exceeds SYNC_RETRY_ATTEMPTS (default 3), the task is marked as 'failed'. This moves it to a "dead-letter-queue" state (as per constraints) and removes it from active syncing, preventing poison-pill items from blocking the queue.

## Assumptions Made
1. **Server Simulation** : The /api/batch endpoint in src/routes/sync.ts is a simulation of the remote server. Its purpose is to accept batch requests and return realistic responses, including conflicts, for the SyncService to handle.

2. **Conflict Logic on Server** : The "last-write-wins" logic resides on the server. The client's responsibility, implemented here, is to correctly handle the server's resolution when a conflict is reported.

3. **Challenge Constraints**: The src/utils/challenge-constraints.ts file was treated as a primary source of truth for implementation details (e.g., retry logic, checksum requirement, sync states).

## AI Guidelines Declaration (Per docs/AI_GUIDELINES.md)
Per the AI Guidelines, I utilized an AI assistant for:

* Clarifying complex concepts, such as offline-first architecture or conflict resolution strategies.

* Debugging specific error messages and TypeScript type-related issues.

* Refining database queries and async/await patterns.


All core logic, including the TaskService and SyncService architecture, the batching process, error handling, and conflict resolution flow, was designed and written by me to meet the specific challenge requirements.