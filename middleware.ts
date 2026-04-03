import { NextRequest, NextResponse } from 'next/server';

/**
 * Middleware to protect routes
 * 
 * If ORG_STUDIO_API_KEY is set (auth enabled), redirect to /login if not authenticated.
 * Otherwise, allow all access (localhost dev mode).
 */
export function middleware(request: NextRequest) {
  const apiKey = process.env.ORG_STUDIO_API_KEY;
  
  // No API key configured — auth is disabled, allow all access
  if (!apiKey) {
    return NextResponse.next();
  }

  // Auth is enabled — check if user is authenticated
  const pathname = request.nextUrl.pathname;

  // Allow login page and auth endpoints without authentication
  if (
    pathname === '/login' ||
    pathname.startsWith('/api/auth/login') ||
    pathname.startsWith('/api/auth/logout')
  ) {
    return NextResponse.next();
  }

  // Check for session cookie or API key
  const cookieHeader = request.headers.get('cookie') || '';
  const sessionToken = cookieHeader.match(/session_token=([a-f0-9]+)/)?.[1];
  const authHeader = request.headers.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  // For API routes with Bearer token auth
  if (authHeader && bearerToken === apiKey) {
    return NextResponse.next();
  }

  // For browser requests with session cookie
  if (sessionToken) {
    // Session validation happens in the API routes
    // Here we just allow the request to proceed
    return NextResponse.next();
  }

  // No valid auth — redirect to login
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - login (login page)
     * 
     * We still need to protect API routes, so we handle those in the route handlers themselves.
     */
    '/((?!api|_next/static|_next/image|favicon.ico|login).*)',
  ],
};
