import { Router, Request, Response, NextFunction } from 'express';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';
import { Task } from '../types';

// Creates and configures the Express Router for task endpoints.
export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);

  //  Fetches all non-deleted tasks.
  router.get('/', async (_: Request, res: Response, next: NextFunction) => {
    try {
      const tasks = await taskService.getAllTasks();
      return res.json(tasks);
    } catch (error) { next(error); return; }
  });

  //  Fetches a single non-deleted task by ID.
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found', timestamp: new Date().toISOString(), path: req.path });
      }
      return res.json(task);
    } catch (error) { next(error); return; }
  });

  //  Creates a new task.
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { title, description } = req.body;
      if (!title || typeof title !== 'string' || title.trim() === '') return res.status(400).json({ error: 'Title required' });
      if (description !== undefined && typeof description !== 'string') return res.status(400).json({ error: 'Description must be string' });
      const taskData: Partial<Task> = { title: title.trim() };
      if (description !== undefined) taskData.description = description.substring(0, 500);
      const newTask = await taskService.createTask(taskData);
      return res.status(201).json(newTask);
    } catch (error) { next(error); return; }
  });

  //  Updates an existing task.
  router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        const { title, description, completed } = req.body;
        const updates: Partial<Task> = {};
        let hasUpdate = false;
        if (title !== undefined) {  updates.title = title.trim(); hasUpdate = true; }
        if (description !== undefined) {  updates.description = description.substring(0, 500); hasUpdate = true; }
        if (completed !== undefined) {  updates.completed = completed; hasUpdate = true; }
        if (!hasUpdate) return res.status(400).json({ error: 'No valid update fields provided' });
        const updatedTask = await taskService.updateTask(id, updates);
        if (!updatedTask) return res.status(404).json({ error: 'Task not found' });
        return res.status(200).json(updatedTask);
    } catch (error) { next(error); return; }
  });

  //  Soft deletes a task.
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const success = await taskService.deleteTask(id);
      if (!success) return res.status(404).json({ error: 'Task not found' });
      return res.status(204).send(); 
    } catch (error) { next(error); return; }
  });

  return router;
}