// Types the JavaScript code relies on but cannot declare itself (used by `npm run typecheck`).

declare namespace Express {
  interface Request {
    /** The signed-in user, set on every request by Auth.attach(); null when nobody is signed in. */
    user: { id: number; username: string; role: 'admin' | 'user'; createdAt: string } | null;
  }
}
