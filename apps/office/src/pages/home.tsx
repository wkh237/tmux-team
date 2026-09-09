import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';

export function HomePage(): ReactElement {
  return (
    <section>
      <p className="eyebrow">Your team's next workspace</p>
      <h1>
        A place for your
        <br />
        people and agents.
      </h1>
      <p className="intro">Private offices. Shared spaces. A team that can work together.</p>
      <div className="empty-world">
        <span className="world-mark" aria-hidden="true">
          ＋
        </span>
        <h2>No world connected</h2>
        <p>
          You're viewing the local foundation. World creation and invitations are not available yet.
        </p>
        <Link to="/setup">See what comes next</Link>
      </div>
    </section>
  );
}
