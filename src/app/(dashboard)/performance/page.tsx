/**
 * /performance was split in #1651:
 *  - Delivery metrics → /team (Performance section)
 *  - Token/cost analytics → /usage
 *  - Skill freshness → /system
 * Redirect keeps old bookmarks/links working.
 */
import { redirect } from 'next/navigation';

export default function PerformanceRedirect() {
  redirect('/team');
}
