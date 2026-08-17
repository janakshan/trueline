"use client";

/**
 * Last-resort boundary. This is the ONLY thing that can catch an error thrown
 * by the root layout — a segment `error.tsx` sits inside the layout it would
 * need to replace, so it never gets the chance.
 *
 * It replaces the entire document, which is why it renders its own <html> and
 * <body>. For the same reason it uses inline styles and system fonts rather
 * than Tailwind or next/font: if the root layout failed, the stylesheet and
 * font variables it provides cannot be assumed to exist. A boundary that
 * depends on the thing that broke is not a boundary.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#fafaf9",
          color: "#1c1917",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
            Something went wrong
          </h1>
          <p style={{ marginTop: 10, fontSize: 14, lineHeight: 1.5, color: "#57534e" }}>
            Trueline hit an unexpected error and could not finish loading.
          </p>
          {error.digest && (
            <p
              style={{
                marginTop: 10,
                fontSize: 12,
                color: "#a8a29e",
                fontFamily: "ui-monospace, monospace",
              }}
            >
              Reference: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 20,
              height: 40,
              padding: "0 20px",
              borderRadius: 6,
              border: "none",
              background: "#1c1917",
              color: "#fff",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
