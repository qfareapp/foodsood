import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Change to your machine's LAN IP when running on a physical device.
 * Android emulator  → http://10.0.2.2:3000/api
 * iOS simulator     → http://localhost:3000/api
 * Physical device   → http://<your-lan-ip>:3000/api
 */
const LOCAL_API_BASE =
  Platform.OS === 'web'
    ? 'http://localhost:3000/api'
    : 'http://192.168.16.22:3000/api';
const RENDER_API_BASE = 'https://foodsood.onrender.com/api';
export const API_BASE = __DEV__ ? LOCAL_API_BASE : RENDER_API_BASE;

// ── Token helpers ─────────────────────────────────────────────────────────
export const Tokens = {
  getAccess: () => SecureStore.getItemAsync('chef_access_token'),
  getRefresh: () => SecureStore.getItemAsync('chef_refresh_token'),
  set: async (access: string, refresh: string) => {
    await SecureStore.setItemAsync('chef_access_token', access);
    await SecureStore.setItemAsync('chef_refresh_token', refresh);
  },
  clear: async () => {
    await SecureStore.deleteItemAsync('chef_access_token');
    await SecureStore.deleteItemAsync('chef_refresh_token');
  },
};

async function refreshChefAccessToken(): Promise<string | null> {
  const refreshToken = await Tokens.getRefresh();
  if (!refreshToken) return null;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await res.json();
    if (!res.ok) {
      await Tokens.clear();
      return null;
    }
    const nextAccess = (data as { accessToken?: string }).accessToken;
    const nextRefresh = (data as { refreshToken?: string }).refreshToken;
    if (!nextAccess || !nextRefresh) {
      await Tokens.clear();
      return null;
    }
    await Tokens.set(nextAccess, nextRefresh);
    return nextAccess;
  } catch {
    return null;
  }
}

async function apiRequest(path: string, options: RequestInit = {}, token?: string | null): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'Aborted' || message.includes('aborted')) {
      throw new Error(`Request timed out while connecting to ${API_BASE}`);
    }
    throw new Error(`Could not reach ${API_BASE}. Check that the backend is running and your device can access this IP.`);
  } finally {
    clearTimeout(timeout);
  }
}

// ── Core fetch wrapper ────────────────────────────────────────────────────
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let token = await Tokens.getAccess();
  let res = await apiRequest(path, options, token);
  if (res.status === 401 && token) {
    const refreshed = await refreshChefAccessToken();
    if (refreshed) {
      token = refreshed;
      res = await apiRequest(path, options, token);
    }
  }
  const data: unknown = await res.json();
  if (!res.ok) {
    const errorValue = (data as { error?: unknown }).error;
    const flattened =
      errorValue && typeof errorValue === 'object' && 'fieldErrors' in (errorValue as Record<string, unknown>)
        ? (errorValue as { fieldErrors?: Record<string, string[]>; formErrors?: string[] })
        : null;
    const fieldMessage = flattened
      ? Object.values(flattened.fieldErrors ?? {}).flat().find(Boolean)
      : null;
    const formMessage = flattened?.formErrors?.find(Boolean) ?? null;
    const msg =
      typeof errorValue === 'string'
        ? errorValue
        : fieldMessage
          ? fieldMessage
          : formMessage
            ? formMessage
            : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

// ── Auth ──────────────────────────────────────────────────────────────────
export const Auth = {
  login: (phone: string, password: string) =>
    api<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone, password }),
    }),

  register: (data: {
    name: string;
    phone: string;
    password: string;
    city?: string;
    lat?: number;
    lng?: number;
  }) =>
    api<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ ...data, role: 'CHEF' }),
    }),

  logout: async (refreshToken: string) => {
    await api('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
    await Tokens.clear();
  },
};

// ── Requests (buyer requests available to quote on) ───────────────────────
export const Requests = {
  nearby: (params?: { lat?: number; lng?: number }) => {
    const qs = new URLSearchParams({ status: 'OPEN,NEGOTIATING', limit: '50' });
    if (params?.lat) { qs.set('lat', String(params.lat)); qs.set('lng', String(params.lng ?? 0)); }
    return api<RequestItem[]>(`/requests?${qs}`);
  },

  get: (id: string) => api<RequestItem>(`/requests/${id}`),

  submitQuote: (requestId: string, body: QuotePayload) =>
    api<QuoteItem>(`/requests/${requestId}/quotes`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ── Quotes ────────────────────────────────────────────────────────────────
export const Quotes = {
  update: (id: string, body: Partial<QuotePayload>) =>
    api<QuoteItem>(`/quotes/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  acceptCounter: (id: string) =>
    api<OrderItem>(`/quotes/${id}/chef-accept-counter`, { method: 'POST' }),

  rejectCounter: (id: string) =>
    api<QuoteItem>(`/quotes/${id}/chef-reject-counter`, { method: 'POST' }),

  withdraw: (id: string) => api<void>(`/quotes/${id}`, { method: 'DELETE' }),
};

// ── Orders ────────────────────────────────────────────────────────────────
export const Orders = {
  list: () => api<OrderItem[]>('/orders?role=chef'),
  get: (id: string) => api<OrderItem>(`/orders/${id}`),
  updateStatus: (id: string, status: OrderStatus) =>
    api<OrderItem>(`/orders/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    }),
};

export const Cooking = {
  nearby: (params?: { lat?: number; lng?: number; radiusKm?: number }) => {
    const qs = new URLSearchParams({ limit: '30' });
    if (params?.lat != null) { qs.set('lat', String(params.lat)); qs.set('lng', String(params.lng ?? 0)); }
    if (params?.radiusKm != null) qs.set('radiusKm', String(params.radiusKm));
    return api<CookingDishItem[]>(`/cooking?${qs}`);
  },
  mine: () => api<CookingDishItem[]>('/cooking/mine'),
  create: (body: CreateCookingDishPayload) =>
    api<CookingDishItem>('/cooking', { method: 'POST', body: JSON.stringify(body) }),
  remove: (id: string) => api<void>(`/cooking/${id}`, { method: 'DELETE' }),
  update: (id: string, body: { extensionMinutes?: number; imageUrl?: string | null }) =>
    api<CookingDishItem>(`/cooking/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
};

// ── Users ─────────────────────────────────────────────────────────────────
export const Users = {
  me: () => api<UserProfile>('/users/me'),
  updateMe: (data: Partial<UserProfile> & { location?: string | null; lat?: number | null; lng?: number | null }) =>
    api<UserProfile>('/users/me', { method: 'PUT', body: JSON.stringify(data) }),
  uploadKitchenImage: (imageData: string) =>
    api<{ url: string }>('/users/me/kitchen-image', { method: 'POST', body: JSON.stringify({ imageData }) }),
  saveAddress: (data: { label: string; address: string; lat?: number; lng?: number }) =>
    api<UserAddress>('/users/me/addresses', { method: 'POST', body: JSON.stringify(data) }),
  saveFcmToken: (token: string) =>
    api<{ success: true }>('/users/me/fcm-token', { method: 'POST', body: JSON.stringify({ token }) }),
  deleteFcmToken: (token: string) =>
    api<{ success: true }>('/users/me/fcm-token', { method: 'DELETE', body: JSON.stringify({ token }) }),
};

export const MarketPrices = {
  catalog: () => api<MarketPriceCatalogItem[]>('/market-prices/catalog'),
  mineToday: () => api<ChefDailyMarketPriceResponse>('/market-prices/mine/today'),
  submitDaily: (body: { city?: string; entries: Array<{ itemKey: string; price?: number | null }> }) =>
    api<{ success: true; city: string; submittedCount: number; submittedForDate: string }>('/market-prices/daily', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ── Offers ────────────────────────────────────────────────────────────────
export const Offers = {
  list: (statuses?: DishOffer['status'][]) => {
    const qs = new URLSearchParams();
    if (statuses?.length) qs.set('statuses', statuses.join(','));
    const suffix = qs.toString() ? `?${qs}` : '';
    return api<DishOffer[]>(`/offers${suffix}`);
  },
  accept: (id: string) => api<DishOffer>(`/offers/${id}/accept`, { method: 'PATCH' }),
  reject: (id: string) => api<DishOffer>(`/offers/${id}/reject`, { method: 'PATCH' }),
  counter: (id: string, counterPrice: number, counterNote?: string) =>
    api<DishOffer>(`/offers/${id}/counter`, {
      method: 'PATCH',
      body: JSON.stringify({ counterPrice, counterNote }),
    }),
  updateOrderStatus: (id: string, status: 'CONFIRMED' | 'OUT_FOR_DELIVERY' | 'DELIVERED') =>
    api<DishOffer>(`/offers/${id}/order-status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
};

export const Moderation = {
  acceptPolicy: () =>
    api<{ success: true }>('/moderation/accept-ugc-policy', { method: 'POST' }),
  report: (body: {
    targetType: 'USER' | 'REVIEW' | 'PROFILE' | 'KITCHEN_IMAGE';
    targetId: string;
    reason: ModerationReason;
    details?: string;
  }) =>
    api('/moderation/reports', { method: 'POST', body: JSON.stringify(body) }),
  blockUser: (userId: string) =>
    api<{ success: true }>(`/moderation/block/${userId}`, { method: 'POST' }),
  unblockUser: (userId: string) =>
    api<{ success: true }>(`/moderation/block/${userId}`, { method: 'DELETE' }),
  relation: (userId: string) =>
    api<{ blocked: boolean; blockedByMe: boolean }>(`/moderation/relation/${userId}`),
};

// ── Types ─────────────────────────────────────────────────────────────────
export interface AuthResponse {
  user: UserProfile;
  accessToken: string;
  refreshToken: string;
}

export interface UserProfile {
  id: string;
  name: string;
  phone: string;
  email?: string;
  role: string;
  avatar?: string;
  coverImage?: string;
  bio?: string;
  cookingStyle?: string;
  location?: string | null;
  city?: string | null;
  lat?: number | null;
  lng?: number | null;
  rating: number;
  ratingCount: number;
  totalOrders: number;
  isActive: boolean;
  ugcPolicyAcceptedAt?: string | null;
  kitchenImages?: string[];
  specialityDishes?: SpecialityDish[];
}

export type ModerationReason = 'HARASSMENT' | 'HATE' | 'SEXUAL' | 'SPAM' | 'IMPERSONATION' | 'SCAM' | 'VIOLENCE' | 'OTHER';

export interface UserAddress {
  id: string;
  label: string;
  address: string;
  lat?: number | null;
  lng?: number | null;
}

export interface SpecialityDish {
  ratingAverage: number;
  ratingCount: number;
  recentReviews: Array<{
    buyerName: string;
    rating: number;
    comment?: string;
    createdAt: string;
  }>;
  dishName: string;
  description: string;
  imageUrl: string;
  lastSoldPrice: number;
  unitsSold: number;
  cuisine: string;
  tags: string[];
  notes: string;
  emoji: string;
  portionType: 'quantity' | 'pieces';
  portionValue: number;
  portionUnit: string;
  readyInMinutes: number;
}

export interface RequestItem {
  id: string;
  dishName: string;
  category: string;
  qty: number;
  people: number;
  spiceLevel: string;
  preferences: string[];
  delivery: string;
  budget: number;
  notes?: string;
  status: string;
  city?: string;
  lat?: number;
  lng?: number;
  createdAt: string;
  distanceKm?: number;
  notifyRadiusKm?: number;
  quotesCount: number;
  user: {
    id: string;
    name: string;
    rating: number;
    avatar?: string;
    city?: string;
  };
  quotes?: QuoteItem[];
}

export interface QuoteItem {
  id: string;
  requestId: string;
  chefId: string;
  price: number;
  cookTime: string;
  delivery: string;
  message?: string;
  style?: string;
  status: string;
  chefQuoteCount?: number;
  buyerCounterCount?: number;
  counterOffer?: number;
  createdAt: string;
}

export interface CookingDishItem {
  id: string;
  emoji: string;
  dishName: string;
  cuisine: string;
  tags: string[];
  pricePerPlate: number;
  plates: number;
  portionType: 'quantity' | 'pieces';
  portionValue: number;
  portionUnit: string;
  readyInMinutes: number;
  notes?: string | null;
  imageUrl?: string | null;
  bookedPlates?: number;
  createdAt: string;
  updatedAt: string;
  status: 'cooking' | 'ready';
  remainingMinutes: number;
  readyAt: string;
  distanceKm?: number | null;
  chef?: {
    id: string;
    name: string;
    avatar?: string | null;
    city?: string | null;
    location?: string | null;
    rating: number;
    ratingCount: number;
    totalOrders: number;
    lat?: number | null;
    lng?: number | null;
  };
}

export interface CreateCookingDishPayload {
  emoji: string;
  dishName: string;
  cuisine: string;
  tags: string[];
  pricePerPlate: number;
  plates: number;
  portionType: 'quantity' | 'pieces';
  portionValue: number;
  portionUnit: string;
  readyInMinutes: number;
  notes?: string;
  imageUrl?: string | null;
}

export interface MarketPriceCatalogItem {
  key: string;
  label: string;
  category: string;
  unit: string;
}

export interface ChefDailyMarketPriceResponse {
  city: string;
  submittedForDate: string;
  entries: Array<{
    itemKey: string;
    price: number;
  }>;
}

export interface QuotePayload {
  price: number;
  cookTime: string;
  delivery: 'pickup' | 'delivery' | 'both';
  message?: string;
  style?: string;
}

export interface DishOffer {
  id: string;
  dishId: string;
  chefId: string;
  buyerName: string;
  buyerToken: string;
  plates: number;
  offerPrice: number;
  exactPriceRequested?: boolean;
  agreedPrice?: number | null;
  holdUntil?: string | null;
  deliveryMode?: 'pickup' | 'delivery' | null;
  orderStatus?: 'CONFIRMED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | null;
  paymentRef?: string | null;
  paidAt?: string | null;
  message?: string;
  status: 'PENDING' | 'COUNTERED' | 'HOLD' | 'PAID' | 'REJECTED' | 'EXPIRED';
  counterPrice?: number | null;
  counterNote?: string | null;
  lastOfferBy: 'BUYER' | 'CHEF';
  dishName: string;
  dishEmoji: string;
  createdAt: string;
  updatedAt: string;
}

export type OrderStatus =
  | 'CONFIRMED'
  | 'COOKING'
  | 'READY'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'CANCELLED';

export interface OrderItem {
  id: string;
  requestId: string;
  quoteId: string;
  buyerId: string;
  chefId: string;
  finalPrice: number;
  status: OrderStatus;
  address?: string;
  cookingStartedAt?: string | null;
  readyAt?: string | null;
  createdAt: string;
  updatedAt: string;
  request: {
    id: string;
    dishName: string;
    category: string;
    qty: number;
    people: number;
    spiceLevel: string;
    preferences: string[];
    delivery: string;
  };
  quote: {
    id: string;
    price: number;
    cookTime: string;
    style?: string;
    delivery: string;
  };
  buyer: {
    id: string;
    name: string;
    phone: string;
    avatar?: string;
  };
  review?: {
    rating: number;
    comment?: string;
  };
}
