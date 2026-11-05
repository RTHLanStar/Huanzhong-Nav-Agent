import { safeImage } from '../lib/format';
import { useApp } from './AppProviders';

/**
 * 站点图标：首页、状态页、下载页、后台共用同一套规则——
 * 后台配置了站点 Logo 就显示 Logo，未配置时回退到站名首字。
 * 这样页头左上角的「网站图标」在任何页面都是同一个，不会出现某页显示通用图标的情况。
 */
export default function BrandLogo({ size, fontSize }: { size?: number; fontSize?: number }) {
  const { info } = useApp();
  const src = safeImage(info?.logo);
  const initial = (info?.siteName || '幻终の导航').trim().charAt(0) || '幻';
  const style = size ? { width: size, height: size, fontSize: fontSize ?? Math.round(size * 0.47) } : undefined;

  return (
    <div className="hz-logo" style={style}>
      {src ? <img src={src} alt="" /> : initial}
    </div>
  );
}
