/**
 * Static CMS pages (Phase 1 scope: hardcoded, no admin editor). Content changes are a code change.
 * These drafts must be reviewed and approved by the store owner before launch (see docs/deployment/LAUNCH_CHECKLIST.md).
 */
export type CmsPage = { title: string; description: string; sections: { heading?: string; body: string[] }[] };

export const CMS_PAGES: Record<string, CmsPage> = {
  about: {
    title: 'About Sri Anantha Cart',
    description: 'Sri Anantha Cart delivers authentic pooja essentials in Tirupati within 15-30 minutes.',
    sections: [
      { body: ['Sri Anantha Cart is Tirupati’s one-stop destination for authentic pooja essentials. From the first diya of the morning to the special occasions your family celebrates, we bring everything your home temple needs — delivered to your doorstep in 15-30 minutes.'] },
      { heading: 'What we offer', body: ['Agarbatti and dhoop, kumkum and haldi, brass diyas and pooja thalis, fresh flowers, camphor, idols and décor, coconuts and fruits, festival items and ready-to-use pooja kits — carefully selected for purity and quality.'] },
      { heading: 'Our promise', body: ['Authentic products sourced from trusted brands and suppliers, fair prices with GST included, and quick, careful delivery across our Tirupati service area.'] },
    ],
  },
  contact: {
    title: 'Contact Us',
    description: 'Get in touch with Sri Anantha Cart customer support.',
    sections: [
      { body: ['We are happy to help with orders, deliveries, returns and product questions. Please keep your order ID (for example SA12345) handy when you contact us.'] },
    ],
  },
  faq: {
    title: 'Frequently Asked Questions',
    description: 'Answers to common questions about ordering, delivery, payment and returns.',
    sections: [
      { heading: 'Where do you deliver?', body: ['We currently deliver within Tirupati. Enter your PIN code using “Delivering to” at the top of the page, or add your address at checkout, to confirm delivery to your area.'] },
      { heading: 'How fast is delivery?', body: ['Choose Deliver Now for delivery in about 15-30 minutes during store hours, or pick a scheduled time slot that suits you.'] },
      { heading: 'How can I pay?', body: ['Cash on Delivery is available for eligible orders. UPI, cards and net banking are shown at checkout whenever online payment is available.'] },
      { heading: 'Are prices inclusive of GST?', body: ['Yes. All prices shown include applicable GST. Your invoice shows the tax breakup.'] },
      { heading: 'Is there a delivery charge?', body: ['A small delivery fee may apply depending on your area. Orders above the free-delivery amount shown in your cart are delivered free.'] },
      { heading: 'How do I track my order?', body: ['Open Track Order from the top of any page, or go to My Orders in your account to see live status updates.'] },
      { heading: 'Can I return an item?', body: ['If something is damaged, incorrect or not as expected, request a return from the order details page within 48 hours of delivery. See our Cancellation & Refund policy for details.'] },
    ],
  },
  terms: {
    title: 'Terms & Conditions',
    description: 'Terms that apply when you use Sri Anantha Cart.',
    sections: [
      { heading: 'Using our service', body: ['By creating an account or placing an order you agree to these terms. You are responsible for keeping access to your registered mobile number secure.'] },
      { heading: 'Orders and pricing', body: ['All orders are subject to product availability and delivery to a serviceable address. Prices include GST and may change before an order is placed; the total shown when you place your order is the amount payable.', 'We may cancel an order if an item becomes unavailable or cannot be delivered. If you have already paid, the full amount is refunded to the original payment method.'] },
      { heading: 'Delivery', body: ['Delivery times are estimates. Please ensure someone is available to receive the order at the address provided.'] },
      { heading: 'Accounts', body: ['We may suspend accounts that misuse the service, including repeated refusal of Cash on Delivery orders.'] },
      { heading: 'Contact', body: ['For any questions about these terms please reach us through the Contact Us page.'] },
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    description: 'How Sri Anantha Cart collects and uses your information.',
    sections: [
      { heading: 'Information we collect', body: ['Your mobile number (for sign-in), name, email (optional), delivery addresses and order history. If you sign in with Google, we receive your name and email address from Google.'] },
      { heading: 'How we use it', body: ['To verify your identity, deliver your orders, provide invoices and customer support, and prevent fraud or abuse. We do not sell your personal information.'] },
      { heading: 'Payments', body: ['Online payments are processed by our payment partner. We never see or store your card numbers, UPI PIN or banking passwords.'] },
      { heading: 'Security and retention', body: ['Sessions are protected with secure, HTTP-only cookies, and one-time codes are stored only in hashed form. Order and tax records are retained as required by law.'] },
      { heading: 'Your choices', body: ['You can update your profile and addresses in Account Settings. To request deletion of your account, contact us through the Contact Us page.'] },
    ],
  },
  'shipping-delivery': {
    title: 'Shipping & Delivery Policy',
    description: 'Delivery areas, timings and charges for Sri Anantha Cart orders.',
    sections: [
      { heading: 'Service area', body: ['We deliver to serviceable PIN codes within Tirupati. Availability is confirmed when you enter your PIN code or address.'] },
      { heading: 'Delivery options', body: ['Deliver Now: about 15-30 minutes during store hours. Scheduled delivery: choose an available time slot at checkout.'] },
      { heading: 'Delivery charges', body: ['A delivery fee may apply based on your area and is shown before you place your order. Orders above the free-delivery threshold are delivered free.'] },
      { heading: 'Failed delivery', body: ['If we cannot reach you at the delivery address, our team will contact you on your registered mobile number to reschedule.'] },
    ],
  },
  'refund-return-policy': {
    title: 'Cancellation & Refund Policy',
    description: 'How cancellations, returns and refunds work at Sri Anantha Cart.',
    sections: [
      { heading: 'Cancellations', body: ['Orders can be cancelled before they are out for delivery. Please contact support with your order ID as soon as possible.'] },
      { heading: 'Returns', body: ['If an item is damaged, incorrect or not as described, request a return from your order details page within 48 hours of delivery. Fresh flowers and perishable items can be returned only if they were damaged or incorrect at delivery.'] },
      { heading: 'Refunds', body: ['Approved refunds are made to the original payment method. Online payments are refunded through our payment partner and usually reach you within 5-7 business days depending on your bank. Cash on Delivery orders are refunded by UPI or bank transfer after verification.'] },
    ],
  },
};
