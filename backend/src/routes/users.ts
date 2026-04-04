import { Router } from 'express';
import { z } from 'zod';
import { AuthRequest, requireAuth } from '../middleware/auth';
import prisma from '../lib/prisma';
import { uploadBase64Image } from '../lib/cloudinary';

const router = Router();

// Public chef fields (safe to expose)
const PUBLIC_CHEF_SELECT = {
      id: true,
      name: true,
      avatar: true,
      coverImage: true,
      bio: true,
  cookingStyle: true,
  city: true,
  rating: true,
  ratingCount: true,
  totalOrders: true,
  role: true,
  createdAt: true,
  specialityDishes: true,
} as const;

const specialityDishSchema = z.object({
  ratingAverage: z.number().min(0).max(5),
  ratingCount: z.number().int().nonnegative(),
  recentReviews: z.array(z.object({
    buyerName: z.string().min(1).max(120),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(500).optional(),
    createdAt: z.string(),
  })).max(5),
  dishName: z.string().min(1).max(120),
  description: z.string().min(1).max(300),
  imageUrl: z.string().url(),
  lastSoldPrice: z.number().int().nonnegative(),
  unitsSold: z.number().int().nonnegative(),
  cuisine: z.string().min(1).max(100),
  tags: z.array(z.string().min(1).max(60)).max(12),
  notes: z.string().max(500),
  emoji: z.string().min(1).max(8),
  portionType: z.enum(['quantity', 'pieces']),
  portionValue: z.number().int().positive(),
  portionUnit: z.string().min(1).max(30),
  readyInMinutes: z.number().int().min(0).max(120),
});

const updateMeSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  email: z.string().email().optional(),
  bio: z.string().max(500).optional(),
  cookingStyle: z.string().max(100).optional(),
  avatar: z.string().url().optional(),
  coverImage: z.string().url().optional(),
  location: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  role: z.enum(['BUYER', 'CHEF', 'BOTH']).optional(),
  kitchenImages: z.array(z.string().url()).max(5).optional(),
  specialityDishes: z.array(specialityDishSchema).max(30).optional(),
});

const addressSchema = z.object({
  label: z.string().min(1).max(40),
  address: z.string().min(5),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

const dishSuggestionsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

// ── GET /api/users/me ───────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: {
      id: true, name: true, phone: true, email: true, role: true,
      avatar: true, coverImage: true, bio: true, cookingStyle: true, location: true,
      city: true, lat: true, lng: true,
      rating: true, ratingCount: true, totalOrders: true,
      isActive: true, kitchenImages: true, specialityDishes: true, createdAt: true, updatedAt: true,
    },
  });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({
    ...user,
    kitchenImages: user.kitchenImages ? JSON.parse(user.kitchenImages) as string[] : [],
    specialityDishes: user.specialityDishes ? JSON.parse(user.specialityDishes) : [],
  });
});

// ── POST /api/users/me/kitchen-image ────────────────────────────────────────
router.post('/me/kitchen-image', requireAuth, async (req: AuthRequest, res) => {
  const { imageData } = req.body as { imageData?: string };
  if (!imageData || !imageData.startsWith('data:')) {
    res.status(400).json({ error: 'imageData (base64 data URI) required' });
    return;
  }
  try {
    const url = await uploadBase64Image(imageData);
    res.json({ url });
  } catch {
    res.status(500).json({ error: 'Image upload failed' });
  }
});

// ── PUT /api/users/me ───────────────────────────────────────────────────────
router.put('/me', requireAuth, async (req: AuthRequest, res) => {
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  if (parsed.data.email) {
    const conflict = await prisma.user.findFirst({
      where: { email: parsed.data.email, NOT: { id: req.user!.userId } },
      select: { id: true },
    });
    if (conflict) {
      res.status(409).json({ error: 'Email already in use' });
      return;
    }
  }

  const { kitchenImages, specialityDishes, ...rest } = parsed.data;
  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: {
      ...rest,
      ...(kitchenImages !== undefined ? { kitchenImages: JSON.stringify(kitchenImages) } : {}),
      ...(specialityDishes !== undefined ? { specialityDishes: JSON.stringify(specialityDishes) } : {}),
    },
    select: {
      id: true, name: true, phone: true, email: true, role: true,
      avatar: true, coverImage: true, bio: true, cookingStyle: true, location: true,
      city: true, lat: true, lng: true,
      rating: true, ratingCount: true, totalOrders: true,
      isActive: true, kitchenImages: true, specialityDishes: true, createdAt: true, updatedAt: true,
    },
  });
  res.json({
    ...user,
    kitchenImages: user.kitchenImages ? JSON.parse(user.kitchenImages) as string[] : [],
    specialityDishes: user.specialityDishes ? JSON.parse(user.specialityDishes) : [],
  });
});

// ── GET /api/users/dish-suggestions ───────────────────────────────────────
router.get('/dish-suggestions', async (req, res) => {
  const parsed = dishSuggestionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const query = parsed.data.q?.toLowerCase() ?? '';
  const limit = parsed.data.limit ?? 12;

  const chefs = await prisma.user.findMany({
    where: {
      role: { in: ['CHEF', 'BOTH'] },
      specialityDishes: { not: null },
    },
    select: { specialityDishes: true },
    take: 200,
  });

  const seen = new Set<string>();
  const matches: string[] = [];

  chefs.forEach((chef) => {
    const items = chef.specialityDishes ? JSON.parse(chef.specialityDishes) as Array<{ dishName?: string }> : [];
    items.forEach((item) => {
      const name = item.dishName?.trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      if (query && !key.includes(query)) return;
      seen.add(key);
      matches.push(name);
    });
  });

  matches.sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aStarts = query ? aLower.startsWith(query) : false;
    const bStarts = query ? bLower.startsWith(query) : false;
    if (aStarts !== bStarts) return aStarts ? -1 : 1;
    return a.localeCompare(b);
  });

  res.json(matches.slice(0, limit));
});

// ── GET /api/users/:id  (public chef profile) ───────────────────────────────
router.get('/:id', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      ...PUBLIC_CHEF_SELECT,
      kitchenImages: true,
      reviewsReceived: {
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, rating: true, comment: true, createdAt: true,
          reviewer: { select: { id: true, name: true, avatar: true } },
        },
      },
    },
  });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({
    ...user,
    kitchenImages: user.kitchenImages ? JSON.parse(user.kitchenImages) as string[] : [],
    specialityDishes: user.specialityDishes ? JSON.parse(user.specialityDishes) : [],
  });
});

// ── GET /api/users/me/addresses ─────────────────────────────────────────────
router.get('/me/addresses', requireAuth, async (req: AuthRequest, res) => {
  const addresses = await prisma.address.findMany({
    where: { userId: req.user!.userId },
    orderBy: { id: 'asc' },
  });
  res.json(addresses);
});

// ── POST /api/users/me/addresses ────────────────────────────────────────────
router.post('/me/addresses', requireAuth, async (req: AuthRequest, res) => {
  const parsed = addressSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const address = await prisma.address.create({
    data: { ...parsed.data, userId: req.user!.userId },
  });
  res.status(201).json(address);
});

// ── DELETE /api/users/me/addresses/:id ──────────────────────────────────────
router.delete('/me/addresses/:id', requireAuth, async (req: AuthRequest, res) => {
  const address = await prisma.address.findUnique({ where: { id: req.params.id } });
  if (!address || address.userId !== req.user!.userId) {
    res.status(404).json({ error: 'Address not found' });
    return;
  }
  await prisma.address.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// ── GET /api/users/me/saved-chefs ───────────────────────────────────────────
router.get('/me/saved-chefs', requireAuth, async (req: AuthRequest, res) => {
  const saved = await prisma.savedChef.findMany({
    where: { savedById: req.user!.userId },
    include: { chef: { select: PUBLIC_CHEF_SELECT } },
    orderBy: { id: 'desc' },
  });
  res.json(saved.map((s) => s.chef));
});

// ── POST /api/users/me/saved-chefs/:chefId ──────────────────────────────────
router.post('/me/saved-chefs/:chefId', requireAuth, async (req: AuthRequest, res) => {
  const { chefId } = req.params;
  if (chefId === req.user!.userId) {
    res.status(400).json({ error: 'Cannot save yourself' });
    return;
  }
  const chef = await prisma.user.findUnique({ where: { id: chefId }, select: { id: true, role: true } });
  if (!chef || (chef.role !== 'CHEF' && chef.role !== 'BOTH')) {
    res.status(404).json({ error: 'Chef not found' });
    return;
  }
  await prisma.savedChef.upsert({
    where: { savedById_chefId: { savedById: req.user!.userId, chefId } },
    create: { savedById: req.user!.userId, chefId },
    update: {},
  });
  res.status(201).json({ success: true });
});

// ── DELETE /api/users/me/saved-chefs/:chefId ────────────────────────────────
router.delete('/me/saved-chefs/:chefId', requireAuth, async (req: AuthRequest, res) => {
  await prisma.savedChef.deleteMany({
    where: { savedById: req.user!.userId, chefId: req.params.chefId },
  });
  res.json({ success: true });
});

// ── POST /api/users/me/fcm-token ────────────────────────────────────────────
router.post('/me/fcm-token', requireAuth, async (req: AuthRequest, res) => {
  const { token } = req.body as { token?: string };
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token required' });
    return;
  }
  await prisma.fcmToken.upsert({
    where: { token },
    create: { userId: req.user!.userId, token },
    update: { userId: req.user!.userId },
  });
  res.json({ success: true });
});

// ── DELETE /api/users/me/fcm-token ──────────────────────────────────────────
router.delete('/me/fcm-token', requireAuth, async (req: AuthRequest, res) => {
  const { token } = req.body as { token?: string };
  if (token) {
    await prisma.fcmToken.deleteMany({ where: { token, userId: req.user!.userId } });
  }
  res.json({ success: true });
});

export default router;
