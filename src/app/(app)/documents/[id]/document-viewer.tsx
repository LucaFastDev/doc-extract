'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { MinusIcon, PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

// The original document beside its fields (PRD US-5.1 AC-1, OQ-44): every page of a PDF, or the
// image, through a signed URL valid for 10 minutes (ARCHITECTURE.md section 5), and zoom in and
// out. PDF pages are drawn by pdf.js, which runs on the main thread: a document has at most 10
// pages (OQ-4), and no separate worker file needs to be served.

const SIGNED_URL_SECONDS = 600
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
const FIT = ZOOM_LEVELS.indexOf(1)
/** PDF pages are drawn at twice their size in points, so zooming in stays sharp. */
const RENDER_SCALE = 2

export function DocumentViewer({ storagePath, mimeType, fileName }: { storagePath: string; mimeType: string; fileName: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(FIT)

  useEffect(() => {
    let cancelled = false
    supabase.storage
      .from('documents')
      .createSignedUrl(storagePath, SIGNED_URL_SECONDS)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error || !data) {
          console.error('The document could not be opened.', error)
          setError('The document could not be shown. Reload the page to try again.')
        } else {
          setUrl(data.signedUrl)
        }
      })
    return () => {
      cancelled = true
    }
  }, [supabase, storagePath])

  return (
    <section aria-label="Document" className="flex min-w-0 flex-col rounded-lg border">
      <div className="flex items-center justify-end gap-1 border-b px-2 py-1">
        <div role="group" aria-label="Zoom" className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => z - 1)}>
            <MinusIcon aria-hidden />
          </Button>
          <output aria-label="Zoom level" className="w-12 text-center text-sm tabular-nums">
            {Math.round(ZOOM_LEVELS[zoom] * 100)}%
          </output>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom in"
            disabled={zoom === ZOOM_LEVELS.length - 1}
            onClick={() => setZoom((z) => z + 1)}
          >
            <PlusIcon aria-hidden />
          </Button>
        </div>
      </div>
      <div className="max-h-[75vh] min-h-48 overflow-auto bg-muted p-2">
        <div className="mx-auto" style={{ width: `${ZOOM_LEVELS[zoom] * 100}%` }}>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {url &&
            (mimeType === 'application/pdf' ? (
              <PdfPages url={url} fileName={fileName} onError={setError} />
            ) : (
              // A signed URL to a private bucket, valid for minutes: next/image would fetch and cache it on the server.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt={fileName} className="block h-auto w-full bg-background" />
            ))}
        </div>
      </div>
    </section>
  )
}

/** Every page of the PDF, one canvas each, as wide as the zoomed frame. */
function PdfPages({ url, fileName, onError }: { url: string; fileName: string; onError: (message: string) => void }) {
  const holder = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'shown'>('loading')

  useEffect(() => {
    let cancelled = false
    const target = holder.current
    let destroy: (() => Promise<void>) | null = null

    async function draw() {
      const pdfjs = await import('pdfjs-dist')
      await import('pdfjs-dist/build/pdf.worker.min.mjs')
      const task = pdfjs.getDocument({ url })
      destroy = () => task.destroy()
      const pdf = await task.promise
      for (let n = 1; n <= pdf.numPages && !cancelled && target; n++) {
        const page = await pdf.getPage(n)
        const viewport = page.getViewport({ scale: RENDER_SCALE })
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.className = 'block h-auto w-full bg-background shadow-sm'
        canvas.setAttribute('role', 'img')
        canvas.setAttribute('aria-label', `${fileName}, page ${n} of ${pdf.numPages}`)
        target.appendChild(canvas)
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise
      }
      if (!cancelled) setState('shown')
    }

    draw().catch((error: unknown) => {
      if (cancelled) return
      console.error('The PDF could not be drawn.', error)
      onError('The document could not be shown. Reload the page to try again.')
    })
    return () => {
      cancelled = true
      void destroy?.()
      target?.replaceChildren()
    }
  }, [url, fileName, onError])

  return (
    <>
      {state === 'loading' && <p className="text-sm text-muted-foreground">Loading the document…</p>}
      <div ref={holder} data-state={state} className="flex flex-col gap-2" />
    </>
  )
}
