import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const MENU_FILE = 'wp-compat-menu.json';

export async function writeHarness(sitePath, token) {
  const dir = join(sitePath, 'wp-content', 'mu-plugins');
  await mkdir(dir, { recursive: true });

  const php = `<?php
/**
 * Plugin Name: WP Compat Harness
 * Description: Local test harness. Never ship this.
 */

define( 'WP_COMPAT_TOKEN', ${JSON.stringify(token)} );

add_action( 'admin_menu', function () {
    global $menu, $submenu;
    $slugs = array();
    foreach ( (array) $menu as $item ) {
        if ( ! empty( $item[2] ) ) { $slugs[] = $item[2]; }
    }
    foreach ( (array) $submenu as $items ) {
        foreach ( (array) $items as $item ) {
            if ( ! empty( $item[2] ) ) { $slugs[] = $item[2]; }
        }
    }
    file_put_contents(
        WP_CONTENT_DIR . '/${MENU_FILE}',
        wp_json_encode( array_values( array_unique( $slugs ) ) )
    );
}, 9999 );

add_action( 'init', function () {
    if ( empty( $_GET['wp_compat_token'] ) ) { return; }
    if ( ! hash_equals( WP_COMPAT_TOKEN, (string) $_GET['wp_compat_token'] ) ) { return; }
    if ( is_user_logged_in() ) { return; }

    $user = get_user_by( 'login', 'admin' );
    if ( ! $user ) { return; }

    $expiration = time() + HOUR_IN_SECONDS;
    $secure     = is_ssl();
    $auth_name  = $secure ? SECURE_AUTH_COOKIE : AUTH_COOKIE;
    $auth_sch   = $secure ? 'secure_auth' : 'auth';

    // auth_redirect() reads $_COOKIE on THIS request, so populate it directly.
    $_COOKIE[ $auth_name ]       = wp_generate_auth_cookie( $user->ID, $expiration, $auth_sch );
    $_COOKIE[ LOGGED_IN_COOKIE ] = wp_generate_auth_cookie( $user->ID, $expiration, 'logged_in' );

    wp_set_current_user( $user->ID );
}, 1 );
`;

  await writeFile(join(dir, 'wp-compat-harness.php'), php, 'utf8');
}

export async function readMenuSlugs(sitePath) {
  try {
    const text = await readFile(join(sitePath, 'wp-content', MENU_FILE), 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function clearMenuSlugs(sitePath) {
  await rm(join(sitePath, 'wp-content', MENU_FILE), { force: true });
}
