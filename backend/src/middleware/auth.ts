import { NextFunction, Request, Response } from 'express';
import { verifyAccess } from '../lib/jwt';

export interface AuthRequest extends Request {
  user?: { userId: string; role: string };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }
  const token = header.slice(7);
  try {
    req.user = verifyAccess(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = header.slice(7);
  try {
    req.user = verifyAccess(token);
  } catch {
    req.user = undefined;
  }
  next();
}

/** Use after requireAuth. Allows only CHEF or BOTH roles. */
export function requireChef(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (req.user.role !== 'CHEF' && req.user.role !== 'BOTH') {
    res.status(403).json({ error: 'Chef role required' });
    return;
  }
  next();
}
