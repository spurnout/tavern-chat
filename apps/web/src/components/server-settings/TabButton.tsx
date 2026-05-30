function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded px-2 py-1 ${
        active ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised'
      }`}
    >
      {children}
    </button>
  );
}

export { TabButton };
