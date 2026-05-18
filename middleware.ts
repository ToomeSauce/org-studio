import { NextRequest, NextResponse } from 'next/server';

/**
 * Middleware: page-route auth gate + #1386 CORS hardening for /api/*.
 *
 * Page-route auth (existing): if ORG_STUDIO_API_KEY is set, redirect to /login
 * when no valid session cookie or matching Bearer is present. Skips API
 * routes (those auth themselves in their handlers).
 *
 * CORS (#1386 Phase 2): for /api/*, allow only origins on an explicit
 * allowlist. Read from ALLOWED_ORIGINS env (comma-separated) if set,
 * otherwise fall back to the hardcoded list. For matched origins, echo the
 * origin (NEVER `*`) on response headers and handle OPTIONS preflight.
 * For non-allowed origins, omit CORS headers entirely so browsers block.
 */

const DEFAULT_ALLOWED_ORIGINS = [
  'https://app.orgstudio.dev',
  'http://localhost:4501',
  'http://localhost:3000',
];

export function allowedOrigins(): string[] {
  const fromEnv = process.env.ALLOWED_ORIGINS;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      // Strip trailing slash for matching consistency.
      .map((s) => s.replace(/\/+$/, ''));
  }
  return DEFAULT_ALLOWED_ORIGINS.slice();
}

function matchOrigin(origin: string | null): string | null {
  if (!origin) return null;
  const normalized = origin.replace(/\/+$/, '');
  const list = allowedOrigins();
  // Match exact or against the same host with implicit https scheme
  // (operators sometimes put 'app.orgstudio.dev' bare in ALLOWED_ORIGINS).
  for (const allowed of list) {
    if (normalized === allowed) return origin;
    if (normalized === `https://${allowed}`) return origin;
    if (normalized === `http://${allowed}`) return origin;
  }
  return null;
}

function applyCorsHeaders(res: NextResponse, matchedOrigin: string): void {
  res.headers.set('Access-Control-Allow-Origin', matchedOrigin);
  res.headers.set('Vary', 'Origin');
  res.headers.set('Access-Control-Allow-Credentials', 'true');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export function handleCors(request: NextRequest): NextResponse | null {
  const pathname = request.nextUrl.pathname;
  if (!pathname.startsWith('/api/')) return null;

  const origin = request.headers.get('origin');
  const matched = matchOrigin(origin);

  // Preflight: always intercept OPTIONS for /api/*.
  if (request.method === 'OPTIONS') {
    if (matched) {
      const res = new NextResponse(null, { status: 204 });
      applyCorsHeaders(res, matched);
      return res;
    }
    // Disallowed origin preflight — return 204 without CORS headers so the
    // browser refuses the actual request.
    return new NextResponse(null, { status: 204 });
  }

  // Non-preflight: pass through, but tag the response with CORS headers
  // when origin is allowed. NextResponse.next() returns the response; we
  // mutate its headers.
  const res = NextResponse.next();
  if (matched) {
    applyCorsHeaders(res, matched);
  }
  return res;
}

export function middleware(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;

  // CORS pass for /api/*: handle preflight and tag responses on allowed
  // origins. We return early so the page-auth redirect logic doesn't run
  // for API routes (they authenticate themselves).
  if (pathname.startsWith('/api/')) {
    const corsRes = handleCors(request);
    return corsRes ?? NextResponse.next();
  }

  // Page-route auth (existing behavior).
  const apiKey = process.env.ORG_STUDIO_API_KEY;
  if (!apiKey) {
    return NextResponse.next();
  }

  if (
    pathname === '/login' ||
    pathname.startsWith('/api/auth/login') ||
    pathname.startsWith('/api/auth/logout')
  ) {
    return NextResponse.next();
  }

  const cookieHeader = request.headers.get('cookie') || '';
  const sessionToken = cookieHeader.match(/session_token=([a-f0-9]+)/)?.[1];
  const authHeader = request.headers.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (authHeader && bearerToken === apiKey) {
    return NextResponse.next();
  }

  if (sessionToken) {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  matcher: [
    // Match page routes (existing) AND /api/* (new, for CORS).
    // We dispatch in the handler based on pathname.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
