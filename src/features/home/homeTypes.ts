import type { Countdown, FriendLink, QqGroup, Site } from '../../lib/types';

export interface Prefs {
  layout: 'large' | 'compact' | 'list';
  font: 's' | 'm' | 'l';
  motion: 'on' | 'off';
  radius: 'on' | 'off';
  order: 'default' | 'custom';
}

export const PREF_DEFAULTS: Prefs = {
  layout: 'large',
  font: 'm',
  motion: 'on',
  radius: 'on',
  order: 'default',
};

export const ENGINES = [
  { id: 'bing', name: '必应', url: 'https://cn.bing.com/search?q=' },
  { id: 'google', name: '谷歌', url: 'https://www.google.com/search?q=' },
  { id: 'zhihu', name: '知乎', url: 'https://www.zhihu.com/search?type=content&q=' },
  { id: 'bilibili', name: 'B站', url: 'https://search.bilibili.com/all?keyword=' },
  { id: 'github', name: 'GitHub', url: 'https://github.com/search?q=' },
];

export interface RecentItem {
  id: string;
  name: string;
  url: string;
  icon?: string;
}

export interface PopularItem {
  id: string;
  name: string;
  url: string;
  icon?: string;
  total: number;
}

export interface HomeData {
  sites: Site[];
  announcements: import('../../lib/types').Announcement[];
  qqGroups: QqGroup[];
  countdowns: Countdown[];
  popular: PopularItem[];
  friendlinks: FriendLink[];
}

export type HomeModal = 'ann' | 'qq' | 'comments' | 'prefs' | 'feedback' | null;
