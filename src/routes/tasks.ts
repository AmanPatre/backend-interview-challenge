import { Router, Request, Response, NextFunction } from 'express';
import { TaskService } from '../services/taskService';
import { SyncService } from '../services/syncService';
import { Database } from '../db/database';
import { Task } from '../types'; 

export function createTaskRouter(db: Database): Router {
  const router = Router();
  
  const taskService = new TaskService(db);
  
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tasks = await taskService.getAllTasks();
      res.json(tasks);
    } catch (error) {
      
      next(error);
    }
  });

  
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(task);
    } catch (error) {
      next(error);
    }
  });

  
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      
      const { title, description } = req.body;
      if (!title || typeof title !== 'string' || title.trim() === '') {
        return res.status(400).json({ error: 'Title is required' });
      }
      if (
        description !== undefined &&
        (typeof description !== 'string' || description.length > 500) 
      ) {
        return res
          .status(400)
          .json({ error: 'Description must be a string up to 500 chars' });
      }

      const taskData: Partial<Task> = { title, description };

      
      const newTask = await taskService.createTask(taskData);

      
      res.status(201).json(newTask);
    } catch (error) {
      next(error);
    }
  });

  
  router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { title, description, completed } = req.body;

      
      if (
        title === undefined &&
        description === undefined &&
        completed === undefined
      ) {
        return res
          .status(400)
          .json({ error: 'At least one field to update is required' });
      }

      
      if (title !== undefined && typeof title !== 'string') {
        return res.status(400).json({ error: 'Title must be a string' });
      }
      if (description !== undefined && typeof description !== 'string') {
        return res
          .status(400)
          .json({ error: 'Description must be a string' });
      }
      if (completed !== undefined && typeof completed !== 'boolean') {
        return res.status(400).json({ error: 'Completed must be a boolean' });
      }

      const updates: Partial<Task> = {};
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (completed !== undefined) updates.completed = completed;

      
      const updatedTask = await taskService.updateTask(id, updates);

      
      if (!updatedTask) {
        return res.status(404).json({ error: 'Task not found' });
      }

      
      res.json(updatedTask);
    } catch (error) {
      next(error);
    }
  });

  
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      
      const success = await taskService.deleteTask(id);

     
      if (!success) {
        return res.status(404).json({ error: 'Task not found' });
      }

     
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
