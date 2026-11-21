/**
 * The settings page.
 *
 * Ticket T1 renders the title only; T3 adds the status panels and T4 the
 * editable scope form.
 */
import { TITLE } from './copy'

export function App(): JSX.Element {
  return (
    <section className="boost-settings" aria-labelledby="boost-title">
      <h2 id="boost-title">{TITLE}</h2>
    </section>
  )
}
