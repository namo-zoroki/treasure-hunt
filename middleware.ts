import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const ADMIN_COOKIE_NAME = 'th_admin';

async function verifyAdminJWT(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
  if (!token) return false;

  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) return false;

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return typeof payload.aid === 'number';
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1. Protection for /api/admin/* routes (except /api/admin/login)
  if (pathname.startsWith('/api/admin')) {
    if (pathname === '/api/admin/login') {
      return NextResponse.next();
    }

    const isValid = await verifyAdminJWT(req);
    if (!isValid) {
      return NextResponse.json(
        { ok: false, code: 'UNAUTHORIZED', message: 'You must be logged in to access this.' },
        { status: 401 }
      );
    }

    return NextResponse.next();
  }

  // 2. Protection for /hq/* admin UI pages
  if (pathname.startsWith('/hq')) {
    const response = NextResponse.next();
    response.headers.set('X-Robots-Tag', 'noindex');

    if (pathname === '/hq/login') {
      const isValid = await verifyAdminJWT(req);
      if (isValid) {
        return NextResponse.redirect(new URL('/hq', req.url));
      }
      return response;
    }

    const isValid = await verifyAdminJWT(req);
    if (!isValid) {
      const loginUrl = new URL('/hq/login', req.url);
      const redirectResponse = NextResponse.redirect(loginUrl);
      redirectResponse.headers.set('X-Robots-Tag', 'noindex');
      return redirectResponse;
    }

    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/hq/:path*', '/api/admin/:path*'],
};
