import { PDFDocument, StandardFonts } from 'pdf-lib'

/** Build a small, real PDF whose text can be extracted by unpdf. */
export async function makePdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595, 842])
  let y = 780
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 12, font })
    y -= 18
  }
  return Buffer.from(await doc.save())
}
