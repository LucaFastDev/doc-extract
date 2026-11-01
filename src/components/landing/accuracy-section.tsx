import type { AccuracyTable } from '@/lib/landing/eval-results'

// The measured accuracy (PRD F15 AC-3): one table per model that has a results file, with the date
// of that run and the model.
export function AccuracySection({ tables }: { tables: AccuracyTable[] }) {
  return (
    <section aria-labelledby="accuracy" className="flex flex-col gap-4">
      <h2 id="accuracy" className="text-2xl font-semibold tracking-tight">
        Measured accuracy
      </h2>
      <p className="text-muted-foreground">
        Measured on a fixed set of 30 fictitious documents, 5 per type. A field counts as correct only when the extracted value
        matches the expected value exactly.
      </p>
      {tables.length === 0 ? (
        <p>The first accuracy run has not been published yet.</p>
      ) : (
        tables.map((table) => (
          <div key={table.model} className="flex flex-col gap-2">
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Accuracy of {table.model} by document type</caption>
                <thead className="bg-muted text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Document type
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Header fields
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Line items
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Target
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row) => (
                    <tr key={row.type} className="border-t">
                      <th scope="row" className="px-3 py-2 font-medium">
                        {row.label}
                      </th>
                      <td className="px-3 py-2">{row.header}</td>
                      <td className="px-3 py-2">{row.lineItems}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{row.target}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-sm text-muted-foreground">
              Run on {table.date} with {table.model}.
            </p>
          </div>
        ))
      )}
    </section>
  )
}
