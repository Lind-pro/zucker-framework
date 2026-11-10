import type { ReactNode } from 'react';
import {
  safeSiteFormAction,
  type SiteAction,
  type SiteBlock,
  type SiteImage,
} from '@zucker-framework/fe-site/content';
import { defineTheme } from './theme';
import type { BlockComponentProps, BlockContext } from './types';

/**
 * Default theme: Tailwind utility classes whose colours come from `--zb-*` CSS variables. The
 * defaults read the host's `--color-*` variables (the Web template's light/dark palette) and fall
 * back to CSS system colours, so the blocks follow light/dark mode with or without that palette.
 * Hosts using Tailwind v4 must add the package's `dist` to their `@source` list.
 *
 * Every component is a pure function (no hooks, no browser APIs) and renders text as React text
 * nodes only; nothing here uses `dangerouslySetInnerHTML`.
 */
export const DEFAULT_THEME_TOKENS = Object.freeze({
  '--zb-bg': 'var(--color-background, Canvas)',
  '--zb-fg': 'var(--color-foreground, CanvasText)',
  '--zb-surface': 'var(--color-card, Canvas)',
  '--zb-border': 'var(--color-border, GrayText)',
  '--zb-muted': 'var(--color-muted, GrayText)',
  '--zb-accent': 'var(--color-primary-600, #4f46e5)',
  '--zb-accent-fg': '#ffffff',
  '--zb-radius': '1rem',
  '--zb-radius-sm': '0.5rem',
});

const ui = {
  panel: 'rounded-[var(--zb-radius)] border border-[var(--zb-border)] bg-[var(--zb-surface)] p-6',
  heading: 'text-2xl font-semibold tracking-tight text-[var(--zb-fg)]',
  lead: 'mt-3 max-w-2xl whitespace-pre-line text-[var(--zb-muted)]',
  muted: 'whitespace-pre-line text-[var(--zb-muted)]',
  primary:
    'inline-flex items-center justify-center rounded-[var(--zb-radius-sm)] bg-[var(--zb-accent)] px-5 py-3 font-medium text-[var(--zb-accent-fg)] hover:opacity-90',
  secondary:
    'inline-flex items-center justify-center rounded-[var(--zb-radius-sm)] border border-[var(--zb-border)] px-5 py-3 font-medium text-[var(--zb-fg)] hover:bg-[var(--zb-surface)]',
  image: 'h-auto max-w-full rounded-[var(--zb-radius)]',
};

function Section({
  block,
  className = '',
  children,
}: {
  block: SiteBlock;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={block.id} data-block-type={block.type} className={className || undefined}>
      {children}
    </section>
  );
}
function Header({ heading, text, center }: { heading: string; text?: string; center?: boolean }) {
  if (!heading && !text) return null;
  return (
    <header className={center ? 'mb-8 text-center' : 'mb-8'}>
      {heading && <h2 className={ui.heading}>{heading}</h2>}
      {text && <p className={`${ui.lead}${center ? ' mx-auto' : ''}`}>{text}</p>}
    </header>
  );
}
function ActionLink({
  action,
  field,
  context,
  primary = true,
}: {
  action: SiteAction;
  field: string;
  context: BlockContext;
  primary?: boolean;
}) {
  const href = context.href(action.href, field);
  if (!href) return null;
  return (
    <a className={primary ? ui.primary : ui.secondary} href={href}>
      {action.label}
    </a>
  );
}
function Img({
  image,
  field,
  context,
  className = ui.image,
  eager = false,
}: {
  image: SiteImage;
  field: string;
  context: BlockContext;
  className?: string;
  eager?: boolean;
}) {
  const src = context.src(image.src, field);
  if (!src) return null;
  return (
    <img
      src={src}
      alt={image.alt}
      width={image.width}
      height={image.height}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      className={className}
    />
  );
}
function MaybeLink({
  href,
  field,
  context,
  className,
  children,
}: {
  href?: string;
  field: string;
  context: BlockContext;
  className?: string;
  children: ReactNode;
}) {
  const safe = href ? context.href(href, field) : null;
  return safe ? (
    <a href={safe} className={className}>
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

function Hero({ block, context }: BlockComponentProps<'hero'>) {
  const H = context.heroHeadingLevel === 1 ? 'h1' : 'h2';
  const split = block.variant === 'split';
  return (
    <Section
      block={block}
      className={`${ui.panel} py-12 ${split ? 'grid items-center gap-10 md:grid-cols-2' : 'text-center'}`}
    >
      <div className={split ? '' : 'mx-auto max-w-3xl'}>
        <H className="text-4xl font-bold tracking-tight text-[var(--zb-fg)] md:text-5xl">
          {block.heading}
        </H>
        {block.text && (
          <p className={`my-5 text-lg ${ui.muted}${split ? '' : ' mx-auto max-w-2xl'}`}>
            {block.text}
          </p>
        )}
        {(block.action || block.secondaryAction) && (
          <div className={`flex flex-wrap gap-3${split ? '' : ' justify-center'}`}>
            {block.action && (
              <ActionLink action={block.action} field="action.href" context={context} />
            )}
            {block.secondaryAction && (
              <ActionLink
                action={block.secondaryAction}
                field="secondaryAction.href"
                context={context}
                primary={false}
              />
            )}
          </div>
        )}
      </div>
      {block.image && (
        <Img
          image={block.image}
          field="image.src"
          context={context}
          eager
          className={`${ui.image}${split ? ' w-full' : ' mx-auto mt-10'}`}
        />
      )}
    </Section>
  );
}

function Markdown({ block, context }: BlockComponentProps<'markdown'>) {
  const slot = context.slots.markdown;
  if (!slot) context.report({ code: 'missing-slot', slot: 'markdown' });
  return (
    <Section block={block}>
      {block.heading && <h2 className={`${ui.heading} mb-5`}>{block.heading}</h2>}
      {slot ? (
        slot({
          markdown: block.markdown,
          anchorPrefix: `block-${block.id}`,
          locale: context.locale,
        })
      ) : (
        <p className="whitespace-pre-line">{block.markdown}</p>
      )}
    </Section>
  );
}

function Features({ block, context }: BlockComponentProps<'features'>) {
  const list = block.variant === 'list';
  const items = block.items.map((item, index) => (
    <article className={list ? 'py-4' : ui.panel} key={index}>
      <h3 className="mb-2 font-semibold text-[var(--zb-fg)]">{item.title}</h3>
      <p className={ui.muted}>{item.text}</p>
    </article>
  ));
  return (
    <Section block={block}>
      <Header heading={block.heading} />
      {list ? (
        <div className={block.image ? 'grid items-center gap-10 md:grid-cols-2' : ''}>
          <div className="divide-y divide-[var(--zb-border)]">{items}</div>
          {block.image && <Img image={block.image} field="image.src" context={context} />}
        </div>
      ) : (
        <>
          {block.image && (
            <Img
              image={block.image}
              field="image.src"
              context={context}
              className={`${ui.image} mb-8 w-full`}
            />
          )}
          <div className="grid gap-4 md:grid-cols-3">{items}</div>
        </>
      )}
    </Section>
  );
}

function Faq({ block }: BlockComponentProps<'faq'>) {
  return (
    <Section block={block}>
      <Header heading={block.heading} />
      <div className="space-y-3">
        {block.items.map((item, index) => (
          <details key={index} className={ui.panel}>
            <summary className="cursor-pointer font-medium">{item.question}</summary>
            <p className={`mt-4 ${ui.muted}`}>{item.answer}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

function Cta({ block, context }: BlockComponentProps<'cta'>) {
  return (
    <Section block={block} className={`${ui.panel} text-center`}>
      <h2 className={ui.heading}>{block.heading}</h2>
      {block.text && <p className={`my-5 ${ui.muted}`}>{block.text}</p>}
      <ActionLink action={block.action} field="action.href" context={context} />
    </Section>
  );
}

function Links({ block, context }: BlockComponentProps<'links'>) {
  return (
    <Section block={block}>
      <Header heading={block.heading} />
      <div className="flex flex-wrap gap-3">
        {block.items.map((item, index) => (
          <ActionLink key={index} action={item} field={`items.${index}.href`} context={context} />
        ))}
      </div>
    </Section>
  );
}

function LogoCloud({ block, context }: BlockComponentProps<'logo-cloud'>) {
  return (
    <Section block={block}>
      {block.heading && (
        <p className="mb-6 text-center text-sm font-medium uppercase tracking-wide text-[var(--zb-muted)]">
          {block.heading}
        </p>
      )}
      <ul className="flex flex-wrap items-center justify-center gap-x-10 gap-y-6">
        {block.items.map((item, index) => (
          <li key={index}>
            <MaybeLink href={item.href} field={`items.${index}.href`} context={context}>
              <Img
                image={{ ...item.image, alt: item.image.alt || item.name }}
                field={`items.${index}.image.src`}
                context={context}
                className="h-10 w-auto opacity-80 grayscale hover:opacity-100 hover:grayscale-0"
              />
            </MaybeLink>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Stats({ block }: BlockComponentProps<'stats'>) {
  return (
    <Section block={block}>
      <Header heading={block.heading} text={block.text} center />
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {block.items.map((item, index) => (
          <div key={index} className={`${ui.panel} text-center`}>
            <dt className="text-sm text-[var(--zb-muted)]">{item.label}</dt>
            <dd className="mt-2 text-3xl font-bold tracking-tight text-[var(--zb-fg)]">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Steps({ block }: BlockComponentProps<'steps'>) {
  return (
    <Section block={block}>
      <Header heading={block.heading} text={block.text} />
      <ol className="grid gap-4 md:grid-cols-3">
        {block.items.map((item, index) => (
          <li key={index} className={ui.panel}>
            <span
              aria-hidden="true"
              className="mb-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--zb-accent)] text-sm font-semibold text-[var(--zb-accent-fg)]"
            >
              {index + 1}
            </span>
            <h3 className="mb-2 font-semibold text-[var(--zb-fg)]">{item.title}</h3>
            <p className={ui.muted}>{item.text}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Testimonials({ block, context }: BlockComponentProps<'testimonials'>) {
  return (
    <Section block={block}>
      <Header heading={block.heading} />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {block.items.map((item, index) => (
          <figure key={index} className={ui.panel}>
            <blockquote className="whitespace-pre-line text-[var(--zb-fg)]">
              {item.quote}
            </blockquote>
            <figcaption className="mt-4 flex items-center gap-3">
              {item.avatar && (
                <Img
                  image={item.avatar}
                  field={`items.${index}.avatar.src`}
                  context={context}
                  className="h-10 w-10 rounded-full object-cover"
                />
              )}
              <span>
                <span className="block font-medium">{item.author}</span>
                {item.role && (
                  <span className="block text-sm text-[var(--zb-muted)]">{item.role}</span>
                )}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
    </Section>
  );
}

function Showcase({ block, context }: BlockComponentProps<'showcase'>) {
  return (
    <Section block={block}>
      <Header heading={block.heading} text={block.text} />
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {block.items.map((item, index) => (
          <article key={index} className={`${ui.panel} overflow-hidden p-0`}>
            <Img
              image={item.image}
              field={`items.${index}.image.src`}
              context={context}
              className="aspect-video w-full object-cover"
            />
            <div className="p-6">
              <h3 className="mb-2 font-semibold text-[var(--zb-fg)]">
                <MaybeLink
                  href={item.href}
                  field={`items.${index}.href`}
                  context={context}
                  className="hover:underline"
                >
                  {item.title}
                </MaybeLink>
              </h3>
              {item.text && <p className={ui.muted}>{item.text}</p>}
            </div>
          </article>
        ))}
      </div>
    </Section>
  );
}

function Pricing({ block, context }: BlockComponentProps<'pricing'>) {
  const slot = context.slots.pricing;
  if (!slot) {
    context.report({ code: 'missing-slot', slot: 'pricing' });
    return null;
  }
  return (
    <Section block={block}>
      <Header heading={block.heading} text={block.text} center />
      {slot({
        block,
        plans: block.plans === 'all' ? 'all' : [...block.plans],
        showCreditPacks: block.showCreditPacks,
        locale: context.locale,
      })}
    </Section>
  );
}

function Newsletter({ block, context }: BlockComponentProps<'newsletter'>) {
  const formAction = safeSiteFormAction(block.formAction);
  if (!formAction) {
    context.report({ code: 'unsafe-href', field: 'formAction' });
    return null;
  }
  const slot = context.slots.newsletter;
  return (
    <Section block={block} className={`${ui.panel} text-center`}>
      <Header heading={block.heading} text={block.text} center />
      {slot ? (
        slot({ block, formAction, locale: context.locale })
      ) : (
        <form
          method="post"
          action={formAction}
          className="mx-auto flex max-w-md flex-col gap-3 sm:flex-row"
        >
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            aria-label={block.emailLabel}
            placeholder={block.emailLabel}
            className="min-w-0 flex-1 rounded-[var(--zb-radius-sm)] border border-[var(--zb-border)] bg-[var(--zb-bg)] px-4 py-3 text-[var(--zb-fg)]"
          />
          <button type="submit" className={ui.primary}>
            {block.buttonLabel}
          </button>
        </form>
      )}
    </Section>
  );
}

function BlogList({ block, context }: BlockComponentProps<'blog-list'>) {
  const slot = context.slots.blogList;
  if (!slot) {
    context.report({ code: 'missing-slot', slot: 'blogList' });
    return null;
  }
  return (
    <Section block={block}>
      <Header heading={block.heading} text={block.text} />
      {slot({
        block,
        limit: block.limit,
        ...(block.category ? { category: block.category } : {}),
        locale: context.locale,
      })}
    </Section>
  );
}

function Changelog({ block, context }: BlockComponentProps<'changelog'>) {
  const slot = context.slots.changelog;
  if (!slot) {
    context.report({ code: 'missing-slot', slot: 'changelog' });
    return null;
  }
  return (
    <Section block={block}>
      <Header heading={block.heading} text={block.text} />
      {slot({ block, limit: block.limit, locale: context.locale })}
    </Section>
  );
}

function Media({ block, context }: BlockComponentProps<'media'>) {
  const src = context.src(block.src, 'src');
  if (!src) return null;
  const poster = block.poster ? context.src(block.poster, 'poster') : null;
  return (
    <Section block={block}>
      <Header heading={block.heading} />
      <figure>
        {block.kind === 'video' ? (
          <video
            controls
            playsInline
            preload="metadata"
            src={src}
            poster={poster ?? undefined}
            aria-label={block.alt}
            width={block.width}
            height={block.height}
            className={`${ui.image} w-full`}
          />
        ) : (
          <img
            src={src}
            alt={block.alt}
            width={block.width}
            height={block.height}
            loading="lazy"
            decoding="async"
            className={`${ui.image} w-full`}
          />
        )}
        {block.caption && (
          <figcaption className="mt-3 text-center text-sm text-[var(--zb-muted)]">
            {block.caption}
          </figcaption>
        )}
      </figure>
    </Section>
  );
}

/** The fallback for every other theme; renders all `SITE_BLOCK_TYPES`. */
export const defaultTheme = defineTheme({
  name: 'default',
  tokens: DEFAULT_THEME_TOKENS,
  blocks: {
    hero: Hero,
    markdown: Markdown,
    features: Features,
    faq: Faq,
    cta: Cta,
    links: Links,
    'logo-cloud': LogoCloud,
    stats: Stats,
    steps: Steps,
    testimonials: Testimonials,
    showcase: Showcase,
    pricing: Pricing,
    newsletter: Newsletter,
    'blog-list': BlogList,
    changelog: Changelog,
    media: Media,
  },
});
