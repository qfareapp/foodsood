import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { AuthRequest, requireAuth, requireChef } from '../middleware/auth';

const router = Router();

const ITEM_CATALOG = [
  { key: 'fish_rohu', label: 'Rohu', category: 'fish', unit: 'kg' },
  { key: 'fish_katla', label: 'Katla', category: 'fish', unit: 'kg' },
  { key: 'fish_hilsa', label: 'Hilsa', category: 'fish', unit: 'kg' },
  { key: 'fish_prawns', label: 'Prawns', category: 'fish', unit: 'kg' },
  { key: 'meat_chicken', label: 'Chicken', category: 'meat', unit: 'kg' },
  { key: 'meat_mutton', label: 'Mutton', category: 'meat', unit: 'kg' },
  { key: 'veg_potato', label: 'Potato', category: 'vegetable', unit: 'kg' },
  { key: 'veg_onion', label: 'Onion', category: 'vegetable', unit: 'kg' },
  { key: 'veg_tomato', label: 'Tomato', category: 'vegetable', unit: 'kg' },
  { key: 'veg_seasonal', label: 'Seasonal Vegetables', category: 'vegetable', unit: 'kg' },
] as const;

const ITEM_BY_KEY = new Map<string, (typeof ITEM_CATALOG)[number]>(ITEM_CATALOG.map((item) => [item.key, item]));
const marketPriceEntries = (prisma as any).marketPriceEntry;

const submissionSchema = z.object({
  city: z.string().min(1).max(120).optional(),
  entries: z.array(z.object({
    itemKey: z.enum(ITEM_CATALOG.map((item) => item.key) as [string, ...string[]]),
    price: z.number().positive().max(100000).nullable().optional(),
  })).default([]),
});

const suggestionSchema = z.object({
  city: z.string().min(1).max(120),
  dishName: z.string().min(1).max(160).optional(),
  category: z.string().min(1).max(80).optional(),
  qtyKg: z.coerce.number().min(0.1).max(100).default(1),
});

function startOfDay(input = new Date()): Date {
  const next = new Date(input);
  next.setHours(0, 0, 0, 0);
  return next;
}

function normalizeCity(city?: string | null): { key: string; label: string } | null {
  const trimmed = city?.trim();
  if (!trimmed) return null;
  const label = trimmed.split(',')[0]?.trim() || trimmed;
  const key = label.toLowerCase().replace(/\s+/g, ' ');
  return key ? { key, label } : null;
}

function roundToNearest(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function summariseByItem(entries: Array<{ itemKey: string; price: number }>) {
  const summary = new Map<string, { total: number; count: number }>();
  for (const entry of entries) {
    const current = summary.get(entry.itemKey) ?? { total: 0, count: 0 };
    current.total += entry.price;
    current.count += 1;
    summary.set(entry.itemKey, current);
  }
  return ITEM_CATALOG
    .map((item) => {
      const aggregate = summary.get(item.key);
      if (!aggregate) return null;
      return {
        itemKey: item.key,
        itemLabel: item.label,
        category: item.category,
        unit: item.unit,
        averagePrice: Math.round((aggregate.total / aggregate.count) * 100) / 100,
        submissions: aggregate.count,
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);
}

function inferRecipe(citySummary: Array<{ itemKey: string; averagePrice: number }>, dishName?: string, category?: string, qtyKg = 1) {
  const haystack = `${dishName ?? ''} ${category ?? ''}`.toLowerCase();
  const hasWord = (value: string) => haystack.includes(value);
  const priceFor = (itemKey: string) => citySummary.find((item) => item.itemKey === itemKey)?.averagePrice ?? null;

  let ingredients: Array<{ itemKey: string; factor: number; fallbackKey?: string }> = [];
  let serviceMultiplier = 1.35;

  if (hasWord('mutton')) {
    ingredients = [{ itemKey: 'meat_mutton', factor: 1 }];
    serviceMultiplier = 1.45;
  } else if (hasWord('chicken')) {
    ingredients = [{ itemKey: 'meat_chicken', factor: 1 }];
    serviceMultiplier = hasWord('biryani') ? 1.5 : 1.4;
  } else if (hasWord('prawn')) {
    ingredients = [{ itemKey: 'fish_prawns', factor: 1 }];
    serviceMultiplier = 1.45;
  } else if (hasWord('hilsa') || hasWord('ilish')) {
    ingredients = [{ itemKey: 'fish_hilsa', factor: 1 }];
    serviceMultiplier = 1.5;
  } else if (hasWord('katla')) {
    ingredients = [{ itemKey: 'fish_katla', factor: 1 }];
    serviceMultiplier = 1.42;
  } else if (hasWord('rohu') || hasWord('fish')) {
    ingredients = [{ itemKey: 'fish_rohu', factor: 1, fallbackKey: 'fish_katla' }];
    serviceMultiplier = 1.42;
  } else if (hasWord('veg') || hasWord('paneer') || hasWord('dal') || hasWord('thali')) {
    ingredients = [
      { itemKey: 'veg_seasonal', factor: 0.55, fallbackKey: 'veg_potato' },
      { itemKey: 'veg_onion', factor: 0.2 },
      { itemKey: 'veg_tomato', factor: 0.2 },
      { itemKey: 'veg_potato', factor: 0.25 },
    ];
    serviceMultiplier = hasWord('thali') ? 1.9 : 1.65;
  } else {
    ingredients = [
      { itemKey: 'veg_seasonal', factor: 0.4, fallbackKey: 'veg_potato' },
      { itemKey: 'veg_onion', factor: 0.2 },
      { itemKey: 'veg_tomato', factor: 0.15 },
    ];
    serviceMultiplier = 1.5;
  }

  const matchedIngredients = ingredients
    .map((ingredient) => {
      const price = priceFor(ingredient.itemKey) ?? (ingredient.fallbackKey ? priceFor(ingredient.fallbackKey) : null);
      return price == null ? null : {
        itemKey: ingredient.itemKey,
        price,
        factor: ingredient.factor,
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);

  if (!matchedIngredients.length) {
    return null;
  }

  const rawCost = matchedIngredients.reduce((sum, item) => sum + (item.price * item.factor), 0) * qtyKg;
  const suggestedPrice = roundToNearest(rawCost * serviceMultiplier, 10);
  return {
    matchedItems: matchedIngredients.map((item) => ({
      itemKey: item.itemKey,
      itemLabel: ITEM_BY_KEY.get(item.itemKey)?.label ?? item.itemKey,
      averagePrice: item.price,
    })),
    suggestedPrice,
    marketCostEstimate: roundToNearest(rawCost, 10),
    confidence: matchedIngredients.length >= 2 ? 'medium' : 'light',
  };
}

router.get('/catalog', (_req, res) => {
  res.json(ITEM_CATALOG);
});

router.get('/suggestion', async (req, res) => {
  const parsed = suggestionSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const cityInfo = normalizeCity(parsed.data.city);
  if (!cityInfo) {
    res.status(400).json({ error: 'City is required' });
    return;
  }

  const today = startOfDay();
  const fallbackWindow = new Date(today);
  fallbackWindow.setDate(fallbackWindow.getDate() - 3);

  let entries = await marketPriceEntries.findMany({
    where: {
      cityKey: cityInfo.key,
      submittedForDate: today,
    },
    select: { itemKey: true, price: true },
  });

  if (!entries.length) {
    entries = await marketPriceEntries.findMany({
      where: {
        cityKey: cityInfo.key,
        submittedForDate: { gte: fallbackWindow },
      },
      select: { itemKey: true, price: true },
    });
  }

  const citySummary = summariseByItem(entries);
  const recipe = inferRecipe(citySummary, parsed.data.dishName, parsed.data.category, parsed.data.qtyKg);

  res.json({
    city: cityInfo.label,
    asOfDate: today.toISOString(),
    summary: citySummary,
    suggestion: recipe,
  });
});

router.get('/mine/today', requireAuth, requireChef, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { city: true, location: true },
  });
  const cityInfo = normalizeCity(user?.city ?? user?.location ?? null);
  const today = startOfDay();

  const entries = cityInfo
    ? await marketPriceEntries.findMany({
      where: {
        chefId: req.user!.userId,
        cityKey: cityInfo.key,
        submittedForDate: today,
      },
      select: { itemKey: true, price: true },
    })
    : [];

  res.json({
    city: cityInfo?.label ?? '',
    submittedForDate: today.toISOString(),
    entries,
  });
});

router.post('/daily', requireAuth, requireChef, async (req: AuthRequest, res) => {
  const parsed = submissionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { city: true, location: true },
  });
  const cityInfo = normalizeCity(parsed.data.city ?? user?.city ?? user?.location ?? null);
  if (!cityInfo) {
    res.status(400).json({ error: 'Set your city in profile before submitting market prices' });
    return;
  }

  const today = startOfDay();
  const cleanEntries = parsed.data.entries
    .filter((entry) => typeof entry.price === 'number' && entry.price > 0)
    .map((entry) => {
      const item = ITEM_BY_KEY.get(entry.itemKey)!;
      return {
        itemKey: entry.itemKey,
        itemLabel: item.label,
        category: item.category,
        unit: item.unit,
        price: entry.price as number,
      };
    });

  await Promise.all(cleanEntries.map((entry) =>
    marketPriceEntries.upsert({
      where: {
        chefId_cityKey_itemKey_submittedForDate: {
          chefId: req.user!.userId,
          cityKey: cityInfo.key,
          itemKey: entry.itemKey,
          submittedForDate: today,
        },
      },
      update: {
        cityLabel: cityInfo.label,
        price: entry.price,
        category: entry.category,
        itemLabel: entry.itemLabel,
        unit: entry.unit,
      },
      create: {
        chefId: req.user!.userId,
        cityKey: cityInfo.key,
        cityLabel: cityInfo.label,
        itemKey: entry.itemKey,
        itemLabel: entry.itemLabel,
        category: entry.category,
        unit: entry.unit,
        price: entry.price,
        submittedForDate: today,
      },
    }),
  ));

  res.json({
    success: true,
    city: cityInfo.label,
    submittedCount: cleanEntries.length,
    submittedForDate: today.toISOString(),
  });
});

export default router;
