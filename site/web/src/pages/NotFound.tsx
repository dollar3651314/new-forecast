import { SimplePage } from '../components/Chrome';
import { useI18n } from '../i18n';

export function NotFound() {
  const { t } = useI18n();
  return (
    <SimplePage>
      <div className="panel">
        <h3>{t('common.notFoundTitle')}</h3>
        <p className="lead">{t('common.notFoundBody')}</p>
        <a href="/">{t('common.home')}</a>
      </div>
    </SimplePage>
  );
}
