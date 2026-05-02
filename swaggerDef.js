module.exports = {
  openapi: '3.0.0',
  info: {
    title: 'Actual Budget Pekao Importer API',
    version: '1.1.0',
    description: 'API przyjmujące dane w formacie JSON (ułatwia integrację z n8n).'
  },
  servers: [{ url: '/' }],
  paths: {
    '/accounts': { get: { summary: 'Lista kont', responses: { 200: { description: 'OK' } } } },
    '/categories': { get: { summary: 'Lista kategorii', responses: { 200: { description: 'OK' } } } },
    '/import': {
      post: {
        summary: 'Importuje CSV przekazany jako tekst w JSON',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  csvData: { 
                    type: 'string', 
                    description: 'Pełna treść pliku CSV jako tekst' 
                  },
                  accountId: { type: 'string' },
                  categoryMapping: { 
                    type: 'object', 
                    description: 'Obiekt Key-Value',
                    example: { "BIEDRONKA": "uuid-123" }
                  },
                  accountMapping: { 
                    type: 'object', 
                    description: 'Obiekt Key-Value',
                    example: { "PRZELEW WŁASNY": { "name": "Oszczędnościowe" } }
                  }
                },
                required: ['csvData', 'accountId']
              }
            }
          }
        },
        responses: { 200: { description: 'OK' } }
      }
    }
  }
};
