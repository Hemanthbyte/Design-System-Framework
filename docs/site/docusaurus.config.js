const config = require('../../design-system.config.js');

module.exports = {
  title: config.projectName || 'Design System',
  tagline: 'Component Specifications & Token Documentation',
  url: 'http://localhost:3000',
  baseUrl: '/',
  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',
  favicon: 'img/favicon.ico',

  presets: [
    [
      '@docusaurus/preset-classic',
      {
        docs: {
          path: 'docs',
          routeBasePath: '/', // Serve docs at the root
          sidebarPath: require.resolve('./sidebars.js'),
        },
        blog: false, // Disable blog
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: config.projectName || 'Design System',
      items: [
        {
          to: config.docs?.baseSlug || '/design-system/foundations',
          label: 'Foundations',
          position: 'left',
        },
        {
          to: config.docs?.tokensSlugBase || '/design-system/tokens/token-index',
          label: 'Tokens',
          position: 'left',
        },
        {
          to: config.docs?.componentsSlugBase || '/design-system/components',
          label: 'Components',
          position: 'left',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Documentation',
          items: [
            { label: 'Foundations', to: config.docs?.baseSlug || '/design-system/foundations' },
            { label: 'Tokens', to: config.docs?.tokensSlugBase || '/design-system/tokens/token-index' },
            { label: 'Components', to: config.docs?.componentsSlugBase || '/design-system/components' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} ${config.projectName || 'Design System'}. All rights reserved.`,
    },
  },
};
