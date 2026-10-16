import React from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/shallow';
import { art } from '../../lib/formatters';
import {
  Clock,
  Download,
  Home,
  Library,
  ListMusic,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
} from '../../lib/icons';
import { usePerfMode } from '../../lib/perf';
import { useAppMode } from '../../stores/app-status';
import { useAuthStore } from '../../stores/auth';
import { isLocalPlaylistUrn } from '../../stores/local-playlists';
import { usePlaylistArtworkStore } from '../../stores/playlist-artwork';
import { useServiceStore } from '../../stores/service';
import { useSettingsStore } from '../../stores/settings';
import { Avatar } from '../ui/Avatar';

type IconCmp = React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

const navItems: { to: string; icon: IconCmp; label: string }[] = [
  { to: '/home', icon: Home, label: 'nav.home' },
  { to: '/search', icon: Search, label: 'nav.search' },
  { to: '/library', icon: Library, label: 'nav.library' },
  { to: '/library/playlists', icon: ListMusic, label: 'nav.playlists' },
  { to: '/import', icon: Plus, label: 'nav.import' },
  { to: '/offline', icon: Download, label: 'nav.offline' },
];

const ROW = 'group relative w-full flex items-center h-10 rounded-xl transition-all duration-200';
const LABEL_T = 'max-width 320ms cubic-bezier(0.2,0.8,0.2,1), opacity 240ms ease';

// Active = quiet glass pill with a thin accent ring + depth. Readable on any
// accent because the accent is only a hairline, text stays white.
const ACTIVE: React.CSSProperties = {
  color: '#fff',
  background: 'rgba(255,255,255,0.06)',
  boxShadow:
    'inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 30%, transparent), inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.45)',
};

/** A label that always exists but folds away purely via CSS on collapse — no JS
 *  mount/unmount, so the sidebar width + labels glide together. */
function Label({
  collapsed,
  children,
  className,
}: {
  collapsed: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`overflow-hidden whitespace-nowrap ${className ?? ''}`}
      style={{ maxWidth: collapsed ? 0 : '142px', opacity: collapsed ? 0 : 1, transition: LABEL_T }}
    >
      {children}
    </span>
  );
}

function IconBox({ children }: { children: React.ReactNode }) {
  return <span className="w-10 shrink-0 flex items-center justify-center">{children}</span>;
}

function isRouteActive(pathname: string, to: string): boolean {
  const path = to.split('?')[0];
  return pathname === path || pathname.startsWith(`${path}/`);
}

function NavItem({
  to,
  icon: Icon,
  label,
  collapsed,
  title,
  alert,
}: {
  to: string;
  icon: IconCmp;
  label: string;
  collapsed: boolean;
  title?: string;
  alert?: boolean;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isActive = isRouteActive(pathname, to);
  // Buttons + imperative navigate instead of NavLink: anchor clicks can be
  // swallowed (defaultPrevented upstream) while imperative navigation always
  // lands — same visuals, same keyboard operability.
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      title={title}
      className={`${ROW} cursor-pointer text-left ${
        isActive
          ? ''
          : alert
            ? 'text-white/85 bg-accent/[0.08] ring-1 ring-accent/20 hover:text-white'
            : 'text-white/45 hover:text-white/80 hover:bg-white/[0.06]'
      }`}
      style={isActive ? ACTIVE : undefined}
    >
      <IconBox>
        <Icon size={18} strokeWidth={1.9} />
      </IconBox>
      <Label collapsed={collapsed} className="text-[13px] font-medium pr-3">
        {label}
      </Label>
    </button>
  );
}

export const Sidebar = React.memo(() => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const user = useAuthStore((s) => s.user);
  const appMode = useAppMode();
  const { collapsed, pinnedPlaylists, toggleSidebar } = useSettingsStore(
    useShallow((s) => ({
      collapsed: s.sidebarCollapsed,
      pinnedPlaylists: s.pinnedPlaylists,
      toggleSidebar: s.toggleSidebar,
    })),
  );
  const perf = usePerfMode();
  const service = useServiceStore((s) => s.service);
  const artworkOverrides = usePlaylistArtworkStore((s) => s.overrides);
  // Pinned playlists follow the service tab: SoundCloud pins in SoundCloud
  // mode, imported (YouTube/Spotify) pins in YouTube mode.
  const visiblePins = pinnedPlaylists.filter((p) =>
    service === 'youtube' ? isLocalPlaylistUrn(p.urn) : !isLocalPlaylistUrn(p.urn),
  );
  const btnCls = `${ROW} text-white/45 hover:text-white/80 hover:bg-white/[0.05] cursor-pointer`;

  return (
    <aside
      className="shrink-0 flex flex-col h-full overflow-hidden border-r border-white/[0.05] pb-3 transition-[width] duration-300 ease-[var(--ease-apple)]"
      style={{
        width: collapsed ? 56 : 196,
        transitionDuration: perf.mode === 'light' ? '0ms' : undefined,
      }}
    >
      <nav className="flex flex-col gap-0.5 px-2 pt-3">
        {navItems.map((item) => (
          <NavItem
            key={item.to}
            to={item.to}
            icon={item.icon}
            label={t(item.label)}
            collapsed={collapsed}
            title={collapsed ? t(item.label) : undefined}
            alert={item.to === '/offline' && appMode !== 'online'}
          />
        ))}
      </nav>

      <div className="px-2 pt-4 space-y-0.5">
        {/* Section header — folds to a hairline divider when collapsed. */}
        <div className="relative h-5 mx-1 mb-0.5">
          <span
            className="absolute inset-x-0 top-1/2 h-px"
            style={{
              background: 'rgba(255,255,255,0.07)',
              opacity: collapsed ? 1 : 0,
              transition: 'opacity 240ms ease',
            }}
          />
          <span
            className="absolute inset-0 flex items-center gap-2 px-2 text-[10px] uppercase tracking-[0.18em] text-white/25 font-semibold whitespace-nowrap"
            style={{ opacity: collapsed ? 0 : 1, transition: 'opacity 240ms ease' }}
          >
            {t('sidebar.quickAccess')}
          </span>
        </div>

        <NavItem
          to="/library?tab=history"
          icon={Clock}
          label={t('library.history')}
          collapsed={collapsed}
          title={collapsed ? t('library.history') : undefined}
        />

        {visiblePins.map((playlist) => {
          const artwork = art(artworkOverrides[playlist.urn] ?? playlist.artworkUrl, 'small');
          const to = `/playlist/${encodeURIComponent(playlist.urn)}`;
          const isActive = isRouteActive(pathname, to);
          return (
            <button
              key={playlist.urn}
              type="button"
              onClick={() => navigate(to)}
              title={collapsed ? playlist.title : undefined}
              className={`${ROW} cursor-pointer text-left ${
                isActive ? '' : 'text-white/45 hover:text-white/80 hover:bg-white/[0.05]'
              }`}
              style={isActive ? ACTIVE : undefined}
            >
              <IconBox>
                {artwork ? (
                  <img
                    src={artwork}
                    alt=""
                    className="w-[18px] h-[18px] rounded-[5px] object-cover ring-1 ring-white/[0.1]"
                    decoding="async"
                    loading="lazy"
                  />
                ) : (
                  <ListMusic size={17} strokeWidth={1.9} />
                )}
              </IconBox>
              <Label collapsed={collapsed} className="text-[12.5px] font-medium pr-3">
                {playlist.title}
              </Label>
            </button>
          );
        })}
      </div>

      <div className="flex-1" />

      <div className="px-2 pb-1 flex flex-col gap-0.5">
        <button
          type="button"
          onClick={toggleSidebar}
          title={collapsed ? t('nav.expand') : undefined}
          className={btnCls}
        >
          <IconBox>
            {collapsed ? (
              <PanelLeftOpen size={17} strokeWidth={1.9} />
            ) : (
              <PanelLeftClose size={17} strokeWidth={1.9} />
            )}
          </IconBox>
          <Label collapsed={collapsed} className="text-[12.5px] font-medium pr-3">
            {t('nav.collapse')}
          </Label>
        </button>

        <NavItem
          to="/settings"
          icon={Settings}
          label={t('nav.settings')}
          collapsed={collapsed}
          title={collapsed ? t('nav.settings') : undefined}
        />
      </div>

      {user &&
        (() => {
          const to = `/user/${encodeURIComponent(user.urn)}`;
          const isActive = isRouteActive(pathname, to);
          return (
            <div className="px-2 pb-3">
              <button
                type="button"
                onClick={() => navigate(to)}
                title={collapsed ? user.username : undefined}
                className={`${ROW} cursor-pointer text-left ${isActive ? '' : 'hover:bg-white/[0.05]'}`}
                style={isActive ? ACTIVE : undefined}
              >
                <span className="w-10 shrink-0 flex items-center justify-center">
                  <Avatar src={user.avatar_url} alt={user.username} size={26} />
                </span>
                <Label collapsed={collapsed} className="flex items-center gap-1.5 pr-3">
                  <span className="text-[12.5px] text-white/55 truncate font-medium">
                    {user.username}
                  </span>
                </Label>
              </button>
            </div>
          );
        })()}
    </aside>
  );
});
