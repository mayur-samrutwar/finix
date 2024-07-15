Finix leverages WhatsApp APIs to capture user commands and perform various actions. Users can:

- Create a new wallet (linked to their phone number)
- Send tokens
- Swap tokens
- View previous transactions
- Create a temporary address (time-bound) to receive funds without sharing their phone number

**/send**

To send money, users need to provide the recipient's phone number (or temporary pay ID), amount, token type, and passkey.

**Passkey**

Finix uses a passkey-based authentication system. When creating a new wallet/keypair, a webhook listens to the command and triggers the authenticator app for passkey entry. The encrypted mobile number-public address mapping is stored in a secure database, while the passkey and its encrypted version are saved in the authenticator app.

For transactions via /send or /swap commands, the system prepares the transaction, sends it to the authenticator app, and gets it signed by the private key, completing the process seamlessly.

**Authenticator App**

Users can either use an existing authenticator app or a dedicated Finix app. This app will overlay the current screen, allowing users to enter their passkey without leaving WhatsApp.

Finix transforms the way people interact with cryptocurrencies, making transactions as easy as sending a text message on WhatsApp. This innovative approach has the potential to significantly enhance crypto adoption by providing a user-friendly, secure, and convenient solution.
