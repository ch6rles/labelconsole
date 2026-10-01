/** Plain-text extraction for search, agent reading and LLM input. */
export async function extractText(body: Buffer, mime: string): Promise<{ text: string; pages?: number } | null> {
  if (mime === 'application/pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(body));
    const { totalPages, text } = await pdfText(pdf, { mergePages: true });
    return { text: String(text).replace(/[ \t]+\n/g, '\n').trim(), pages: totalPages };
  }
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return { text: body.toString('utf8') };
  }
  return null;
}
