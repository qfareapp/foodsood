import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';

import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import cookingRoutes from './routes/cooking';
import marketPriceRoutes from './routes/marketPrices';
import moderationRoutes from './routes/moderation';
import offerRoutes from './routes/offers';
import orderRoutes from './routes/orders';
import quoteRoutes from './routes/quotes';
import requestRoutes from './routes/requests';
import userRoutes from './routes/users';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 3000;
const HOST = process.env.HOST ?? '0.0.0.0';

app.use(cors());
app.use(express.json());

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/cooking', cookingRoutes);
app.use('/api/market-prices', marketPriceRoutes);
app.use('/api/moderation', moderationRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/quotes', quoteRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/offers', offerRoutes);
app.use('/api/admin', adminRoutes);

const adminDir = path.join(__dirname, '../../admin');
const legalDir = path.join(__dirname, '../../legal');
app.use('/admin', express.static(adminDir));
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(adminDir, 'index.html'));
});
app.use(express.static(legalDir));
app.get('/privacy-policy', (_req, res) => {
  res.sendFile(path.join(legalDir, 'privacy-policy.html'));
});
app.get('/account-deletion', (_req, res) => {
  res.sendFile(path.join(legalDir, 'account-deletion.html'));
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(Number(PORT), HOST, () => {
  console.log(`NeighbourBites API running on http://${HOST}:${PORT}`);
});

export default app;
