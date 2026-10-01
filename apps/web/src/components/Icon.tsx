type IconName =
  | 'arrow-left'
  | 'chevron-down'
  | 'clock'
  | 'compose'
  | 'logout'
  | 'refresh'
  | 'search'
  | 'send'
  | 'slack'
  | 'upload';

const paths: Record<IconName, React.ReactNode> = {
  'arrow-left': <path d="m15 18-6-6 6-6M9 12h10" />,
  'chevron-down': <path d="m8 10 4 4 4-4" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  compose: (
    <>
      <path d="M13.5 6.5 17.5 10.5M5 19l3.6-.8L18.4 8.4a2 2 0 0 0-2.8-2.8L5.8 15.4 5 19Z" />
      <path d="M13 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-7" />
    </>
  ),
  logout: (
    <>
      <path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />
      <path d="m14 8 4 4-4 4M18 12H9" />
    </>
  ),
  refresh: (
    <>
      <path d="M19 8a7.5 7.5 0 1 0 .3 7.3" />
      <path d="M19 4v4h-4" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m16 16 4 4" />
    </>
  ),
  send: <path d="m4 5 16 7-16 7 3-7-3-7Zm3 7h13" />,
  slack: (
    <>
      <path d="M8.5 3.5a2 2 0 1 1 0 4h-2a2 2 0 0 1 0-4h2Zm0 5v7" />
      <path d="M20.5 8.5a2 2 0 1 1-4 0v-2a2 2 0 0 1 4 0v2Zm-5 0h-7" />
      <path d="M15.5 20.5a2 2 0 1 1 0-4h2a2 2 0 0 1 0 4h-2Zm0-5v-7" />
      <path d="M3.5 15.5a2 2 0 1 1 4 0v2a2 2 0 0 1-4 0v-2Zm5 0h7" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4m0 0L8 8m4-4 4 4" />
      <path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      {paths[name]}
    </svg>
  );
}
