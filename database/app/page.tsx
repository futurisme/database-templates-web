import Link from 'next/link';
import { SearchBox } from '@/components/SearchBox';
import { FeaturedTemplates } from '@/components/FeaturedTemplates';
import { featuredFallback } from '@/lib/featured-fallback';

export default function HomePage() {
  return (
    <main className="page-shell">
      <SearchBox />

      <section className="hero card compact">
        <p className="badge">TemplateDatabase</p>
        <h1>Temukan template terbaik secepat mesin pencari modern.</h1>
        <p className="muted hero-copy">Cari cepat, lihat featured, lalu kontribusi.</p>
        <div className="hero-cta">
          <Link href="/contribute" className="button-link">
            Contribute Template
          </Link>
        </div>
      </section>

      <aside className="panel-side card compact">
        <h2>Featured Templates</h2>
        <FeaturedTemplates items={featuredFallback} error="Mode antarmuka aktif tanpa backend/database." />
      </aside>
    </main>
  );
}
