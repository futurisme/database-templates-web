import Link from 'next/link';

const projects = [
  {
    title: 'TemplateDatabase Core',
    summary: 'Pipeline template open-source dengan indexing cepat dan fallback aman.'
  },
  {
    title: 'Search UX Experiments',
    summary: 'Eksperimen UX untuk instant search dan filter minim friction.'
  },
  {
    title: 'Railway Bootstrap Flow',
    summary: 'Startup resilient untuk mengurangi error saat cold boot.'
  }
] as const;

export default function PortfolioPage() {
  return (
    <main className="portfolio-main">
      <section className="card">
        <span className="badge">/portfolio</span>
        <h1>Portfolio Testing</h1>
        <p className="muted">Halaman portfolio aktif dan bisa diakses normal di Vercel.</p>
      </section>

      <section className="grid">
        {projects.map((project) => (
          <article key={project.title} className="card">
            <h3>{project.title}</h3>
            <p className="muted">{project.summary}</p>
          </article>
        ))}
      </section>

      <section className="card">
        <p>
          Compatibility: <Link href="/Portfolio">/Portfolio</Link> diarahkan ke <strong>/portfolio</strong>.
        </p>
      </section>
    </main>
  );
}
