import type { FastifyPluginAsync } from 'fastify';
import { listModels } from '../services/model-discovery.js';

export const modelRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { refresh?: string } }>('/models', async (req) => {
    const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
    const models = listModels({ refresh });
    return { models };
  });
};
