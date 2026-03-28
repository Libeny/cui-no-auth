import { Router, Request } from 'express';
import { ConfigService } from '@/services/config-service.js';
import type { CUIConfig, EnvPreset } from '@/types/config.js';
import { createLogger } from '@/services/logger.js';
import { v4 as uuidv4 } from 'uuid';

export function createConfigRoutes(service: ConfigService): Router {
  const router = Router();
  const logger = createLogger('ConfigRoutes');

  router.get('/', (req, res, next) => {
    try {
      res.json(service.getConfig());
    } catch (error) {
      logger.error('Failed to get config', error);
      next(error);
    }
  });

  router.put('/', async (req: Request<Record<string, never>, unknown, Partial<CUIConfig>>, res, next) => {
    try {
      await service.updateConfig(req.body);
      res.json(service.getConfig());
    } catch (error) {
      logger.error('Failed to update config', error);
      next(error);
    }
  });

  // --- Env Presets CRUD ---

  // GET /env-presets
  router.get('/env-presets', (req, res, next) => {
    try {
      const config = service.getConfig();
      res.json(config.envPresets || []);
    } catch (error) {
      logger.error('Failed to get env presets', error);
      next(error);
    }
  });

  // POST /env-presets  — create
  router.post('/env-presets', async (req: Request<Record<string, never>, unknown, Omit<EnvPreset, 'id'>>, res, next) => {
    try {
      const config = service.getConfig();
      const presets = config.envPresets || [];
      const newPreset: EnvPreset = {
        id: uuidv4(),
        name: req.body.name,
        proxy: req.body.proxy,
        noProxy: req.body.noProxy,
        envVars: req.body.envVars,
      };
      presets.push(newPreset);
      await service.updateConfig({ envPresets: presets });
      res.status(201).json(newPreset);
    } catch (error) {
      logger.error('Failed to create env preset', error);
      next(error);
    }
  });

  // PUT /env-presets/:id  — update
  router.put('/env-presets/:id', async (req: Request<{ id: string }, unknown, Partial<EnvPreset>>, res, next) => {
    try {
      const config = service.getConfig();
      const presets = config.envPresets || [];
      const idx = presets.findIndex(p => p.id === req.params.id);
      if (idx === -1) {
        res.status(404).json({ error: 'Env preset not found' });
        return;
      }
      const updated: EnvPreset = { ...presets[idx], ...req.body, id: req.params.id };
      presets[idx] = updated;
      await service.updateConfig({ envPresets: presets });
      res.json(updated);
    } catch (error) {
      logger.error('Failed to update env preset', error);
      next(error);
    }
  });

  // DELETE /env-presets/:id
  router.delete('/env-presets/:id', async (req: Request<{ id: string }>, res, next) => {
    try {
      const config = service.getConfig();
      const presets = config.envPresets || [];
      const idx = presets.findIndex(p => p.id === req.params.id);
      if (idx === -1) {
        res.status(404).json({ error: 'Env preset not found' });
        return;
      }
      presets.splice(idx, 1);
      await service.updateConfig({ envPresets: presets });
      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to delete env preset', error);
      next(error);
    }
  });

  return router;
}
