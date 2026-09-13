import type { Metadata } from "next";
import { Instrument_Serif, Newsreader, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "推文存檔閱覽室",
  description:
    "在 Internet Archive 上查詢特定 Twitter/X 帳號被存檔過的所有推文，並查核每則推文目前是否仍然存在。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-Hant"
      className={`${instrumentSerif.variable} ${newsreader.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="relative min-h-full flex flex-col">
        <div className="relative z-10 flex min-h-full flex-1 flex-col">{children}</div>
      </body>
    </html>
  );
}
