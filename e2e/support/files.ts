import type { Page } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'

// Files for the upload specs, made in the test: PDFs of a chosen page count, and images that are
// only their magic bytes, which is all submit-document reads of an image (one image is one page).

export interface FilePayload {
  name: string
  mimeType: string
  buffer: Buffer
}

export async function pdfFile(name: string, pages: number): Promise<FilePayload> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([595, 842])
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) }
}

export function pngFile(name: string): FilePayload {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
  return { name, mimeType: 'image/png', buffer: Buffer.from(bytes) }
}

export function jpegFile(name: string): FilePayload {
  return { name, mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]) }
}

/** The upload control's file input, behind its "Choose files" label. */
export function picker(page: Page) {
  return page.getByLabel('Choose files')
}

export function dropZone(page: Page) {
  return page.getByRole('region', { name: 'Upload documents' })
}

/** Drops the files on the upload control, as a drag from the desktop would. */
export async function dropFiles(page: Page, files: FilePayload[]) {
  const dataTransfer = await page.evaluateHandle(
    (payloads) => {
      const transfer = new DataTransfer()
      for (const f of payloads) {
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))
        transfer.items.add(new File([bytes], f.name, { type: f.mimeType }))
      }
      return transfer
    },
    files.map((f) => ({ name: f.name, mimeType: f.mimeType, base64: f.buffer.toString('base64') })),
  )
  await dropZone(page).dispatchEvent('dragenter', { dataTransfer })
  await dropZone(page).dispatchEvent('dragover', { dataTransfer })
  await dropZone(page).dispatchEvent('drop', { dataTransfer })
}
