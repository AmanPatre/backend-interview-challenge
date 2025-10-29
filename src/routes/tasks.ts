import { Router, Request, Response, NextFunction } from 'express';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';
import { Task } from '../types';

export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);

  router.get('/', async (
    _: Request,
    res: Response,
    next: NextFunction
   ) => {
    try {
      const tasks = await taskService.getAllTasks();
      return res.json(tasks);
    } catch (error) {
      next(error);
      return;
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({
          error: 'Task not found',
          timestamp: new Date().toISOString(),
          path: req.path
         });
      }
      return res.json(task);
    } catch (error) {
      next(error);
      return;
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { title, description } = req.body;

      if (!title || typeof title !== 'string' || title.trim() === '') {
        return res.status(400).json({ error: 'Title is required and must be a non-empty string' });
      }
      if (description !== undefined && typeof description !== 'string') {
        return res.status(400).json({ error: 'Description must be a string if provided' });
      }

      const taskData: Partial<Task> = { title: title.trim() };
      if (description !== undefined) {
        taskData.description = description.length > 500 ? description.substring(0, 500) : description;
      }

      const newTask = await taskService.createTask(taskData);
      return res.status(201).json(newTask);
    } catch (error) {
      next(error);
      return;
    }
  });

  router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        const { title, description, completed } = req.body;

        const updates: Partial<Task> = {};
        let hasUpdate = false;

        if (title !== undefined) {
            if (typeof title !== 'string' || title.trim() === '') {
                return res.status(400).json({ error: 'Title must be a non-empty string if provided' });
            }
            updates.title = title.trim();
            hasUpdate = true;
        }
        if (description !== undefined) {
             if (typeof description !== 'string') {
                return res.status(400).json({ error: 'Description must be a string if provided' });
             }
             updates.description = description.length > 500 ? description.substring(0, 500) : description;
            hasUpdate = true;
        }
        if (completed !== undefined) {
            if (typeof completed !== 'boolean') {
                return res.status(400).json({ error: 'Completed must be a boolean if provided' });
            }
            updates.completed = completed;
            hasUpdate = true;
        }

        if (!hasUpdate) {
            return res.status(400).json({ error: 'At least one field (title, description, completed) must be provided for update' });
        }

      const updatedTask = await taskService.updateTask(id, updates);

      if (!updatedTask) {
        return res.status(404).json({
           error: 'Task not found',
           timestamp: new Date().toISOString(),
           path: req.path
         });
      }

      return res.status(200).json(updatedTask);
    } catch (error) {
      next(error);
      return;
    }
  });

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const success = await taskService.deleteTask(id);

      if (!success) {
        return res.status(404).json({
            error: 'Task not found',
            timestamp: new Date().toISOString(),
            path: req.path
        });
      }

      return res.status(204).send();
    } catch (error) {
      next(error);
      return;
    }
  });

  return router;
}