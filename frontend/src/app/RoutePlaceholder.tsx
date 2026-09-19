import { useLocation } from 'react-router-dom';

export default function RoutePlaceholder() {
  const location = useLocation();
  const tool = location.pathname.split('/').filter(Boolean)[0] ?? 'chat';

  return (
    <main aria-labelledby="page-title" style={{ minHeight: '100vh', padding: '2rem' }}>
      <h1 id="page-title" style={{ margin: 0, fontSize: '1.25rem', textTransform: 'capitalize' }}>
        {tool === 'code' ? 'Hyperion Code' : tool}
      </h1>
      <p style={{ color: 'var(--text-secondary)' }}>Milestone A foundation</p>
    </main>
  );
}
