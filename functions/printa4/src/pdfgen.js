import {
  PDFDocument,
  rgb,
  StandardFonts
} from 'pdf-lib';

export async function createPdf(pageCount = 1) {

  const pdf = await PDFDocument.create();

  const font = await pdf.embedFont(
    StandardFonts.Helvetica
  );

  for (let i = 0; i < pageCount; i++) {

    const page = pdf.addPage([595.28, 841.89]); // A4

    const { width, height } = page.getSize();

    // ------------------------------------------------------------------
    // Invisible watermark settings
    // ------------------------------------------------------------------

    const watermarkText = "PRINTA4";

    // Very near white
    const color = rgb(
      250 / 255,
      250 / 255,
      250 / 255
    );

    // Rotate diagonally
    const angle = Math.PI / 4;

    // Dense repeated watermark
    for (let y = -height; y < height * 2; y += 40) {

      for (let x = -width; x < width * 2; x += 120) {

        page.drawText(watermarkText, {
          x,
          y,
          size: 8,
          font,
          color,
          rotate: {
            type: 'degrees',
            angle: 45
          }
        });
      }
    }
  }

  const pdfBytes = await pdf.save();

  return Buffer.from(pdfBytes);
}