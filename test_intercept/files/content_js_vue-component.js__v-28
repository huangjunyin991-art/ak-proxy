/**
 * 这个文件用来定义页面使用到的公共组件
 * 方便后续项目使用工程化时好迁移
 */

Vue.component('custom-button', {
  props: {
    /** 文本 */
    text: {
      required: true,
      type: String
    },

    /** 高度 */
    height: {
      type: Number,
      required: false,
      default: 45
    },

    /**
     * 是否显示Loading
     * - (true) 显示
     * - (false) 不显示
     */
    loading: {
      default: false,
      type: Boolean,
      required: false
    }
  },
  methods: {
    click() {
      if (this.loading) return

      this.$emit('click')
    }
  },
  template: `
    <div
      class="CustomButton"
      @click="$emit('click')"
      :style="$attrs.style">
      <div class="custom-content" :style="{ height: height + 'px' }">
        <van-loading v-if="loading" color="#fff" />
        <template v-else>{{ text }}</template>
      </div>
    </div>
  `
})

Vue.component('top-back', {
  props: {
    title: {
      type: String,
      required: true
    },
    titleFontSize: {
      type: Number,
      required: false,
      default: 18
    },
    titleColor: {
      type: String,
      required: false,
      default: '#333'
    },
  },
  methods: {
    handleClick() {
      const _this = this
      const $listeners = _this.$listeners
      const clickEvent = $listeners['click']

      clickEvent ? clickEvent() : APP.GLOBAL.closeWindow()
    }
  },

  template: `
    <div class="TopBack">
      <div class="icon" @click="handleClick"></div>
      <div class="title" :style="{ fontSize: titleFontSize + 'px', color: titleColor }">
        {{ title }}
      </div>
      <slot name="right"></slot>
    </div>
  `
})

Vue.component('checkbox', {
  props: {
    /**
     * 是否选中
     * - (true) 选中
     * - (false) 未选中
     */
    checked: {
      default: false,
      type: Boolean,
      required: false
    }
  },
  template: `
    <div class="Checkbox" :class="{ checked }" />
  `
})

Vue.component('tab-bar', {
  props: {
    currentIndex: {
      default: 0,
      type: Number,
      required: true
    }
  },
  data: () => ({
    language: {}
  }),
  created() {
    const _this = this

    _this.changeLanguage()
  },
  methods: {
    jump(item) {
      if (item.index === this.currentIndex) return

      window.location = item.url
    },

    changeLanguage() {
      const _this = this

      LSE.install('home', function(lang) {
          Vue.set(_this, 'language', lang)
      });
    }
  },
  computed: {
    menus() {
      const _this = this
      const { language } = _this

      return [
        {
          'index': 0,
          'text': language.BOTTOM_MENU_1,
          'default': 'iconhome',
          'active': 'iconhomefill',
          'url': 'home.html',
          'icon': '/assets/images/common/tabar-item-home.svg',
          'bgColor': 'rgba(173, 177, 255, 0.39)'
        },
        {
          'index': 1,
          'text': language.BOTTOM_MENU_2,
          'default': 'iconpuke',
          'active': 'iconpuke_fill',
          'url': 'ace.list.html',
          'icon': '/assets/images/common/tabar-item-ak.svg',
          'bgColor': 'rgba(171, 211, 255, 0.39)'
        },
        {
          'index': 2,
          'text': language.BOTTOM_MENU_3,
          'default': 'iconjiaoyi',
          'active': 'iconjiaoyi_fill',
          'url': 'ep.list.html',
          'icon': '/assets/images/common/tabar-item-ep.svg',
          'bgColor': 'rgba(255, 201, 149, 0.39)'
        },
        {
          'index': 3,
          'text': language.BOTTOM_MENU_4,
          'default': 'iconmy',
          'active': 'iconmyfill',
          'url': 'center.html',
          'icon': '/assets/images/common/tabar-item-my.svg',
          'bgColor': 'rgba(125, 241, 221, 0.39)'
        }
      ]
    }
  },
  template: `
    <div id="bottom" class="panel pos van-hairline--top">
      <ul id="bottom-menus-items" class="menus clearfix">
        <li v-for="(item, index) in menus" v-bind:key="index" v-bind:class="{'active': currentIndex === item.index}" @click="jump(item)">
          <div class="img-box" :style="{backgroundColor: currentIndex === item.index ? item.bgColor : ''}"><img :src="item.icon"></div>
          <p class="menus-text" v-text="item.text"></p>
        </li>
      </ul>
    </div>
  `
})

Vue.component('google-v-code', {
  model: {
    prop: 'value',
    event: 'change'
  },
  props: {
    value: String
  },
  data: () => ({
    language: {}
  }),
  created() {
    const _this = this

    LSE.install('GoogleVCode', function(lang) {
      Vue.set(_this, 'language', lang)
    })
  },
  methods: {
    clipFunc: function() {
      const _this = this

      navigator.clipboard
      .readText()
      .then((v) => {
        _this.$emit('change', v)
        console.log("获取剪贴板成功：", v);
      })
      .catch((v) => {
        console.log("获取剪贴板失败: ", v);
      });
    },
  },
  template: `
    <div class="GoogleVCode">
      <div class="g-text">{{ language.t1 }}</div>
      <input
        ttype="number"
        class="g-input"
        :placeholder="language.t2"
        :value="value"
        maxlength="6"
        @input="$emit('change', $event.target.value)"
      />
      <img class="g-icon" src="/assets/svg/icon6.svg" @click="clipFunc" />
    </div>
  `
})

Vue.component('hold-assets', {
  props: {
    /** 持有资产名称 */
    label: {
      type: String,
      required: true
    },

    /** 持有资产值 */
    value: {
      type: String,
      required: true
    }
  },
  computed: {
    getIconBgColor() {
      const _this = this
      let color = ''

      switch (_this.label) {
        case 'EP':
          color = 'linear-gradient(180deg, rgba(255, 176, 0, 1), rgba(255, 147, 0, 1))'
        break
        case 'RP':
          color = 'linear-gradient(180deg, #87FFBD 0%, #11CF4A 100%)'
        break
        case 'TP':
          color = 'linear-gradient(180deg, #87EDFF 0%, #11CFBF 100%)'
        break
      }

      return color
    }
  },
  template: `
    <div class="HoldAssets">
      <div class="icon" :data-text="label" :style="{ backgroundImage: getIconBgColor }"></div>
      <div class="value">{{ value }}</div>
    </div>
  `
})

Vue.component('switch-language', {
  model: {
    prop: 'visible',
    event: 'closed'
  },
  props: {
    visible: {
      type: Boolean,
      default: false
    }
  },
  data: () => ({
    language: {},
    items: [
      {
        key: 'cn',
        icon: '/assets/images/languages/image1@1x.png',
        name: '中文'
      },
      {
        key: 'en',
        icon: '/assets/images/languages/image2@1x.png',
        name: 'English'
      },
      {
        key: 'ko',
        icon: '/assets/images/languages/image3@1x.png',
        name: '한국인'
      },
      {
        key: 'jp',
        icon: '/assets/images/languages/image4@1x.png',
        name: '日本語'
      },
      {
        key: 'de',
        icon: '/assets/images/languages/image5@1x.png',
        name: 'Deutsch'
      },
      {
        key: 'es',
        icon: '/assets/images/languages/image6@1x.png',
        name: 'Espanol'
      },
      {
        key: 'fr',
        icon: '/assets/images/languages/image7@1x.png',
        name: 'Francais'
      },
      {
        key: 'pt',
        icon: '/assets/images/languages/image8@1x.png',
        name: 'Portugues'
      },
      {
        key: 'th',
        icon: '/assets/images/languages/image9@1x.png',
        name: 'แบบไทย'
      }
    ]
  }),
  created() {
    this.changeLanguage()
  },
  methods: {
    /**
     * 切换语言
     * @param { String } key 语言key
     */
    selectLanguage(key) {
      LSE.switchLanguage(key)

      window.location.reload()
    },

    changeLanguage() {
      const _this = this

      LSE.install('language', function (lang) {
        Vue.set(_this, 'language', lang)
      })
    }
  },
  template: `
    <van-popup
      v-model="visible"
      position="bottom"
      style="background-color: transparent;"
      :overlay-style="{ backgroundColor: 'rgba(0, 0, 0, .7)' }"
      :get-container="() => document.body"
      @closed="$emit('closed', false)">
      <div class="Languages">
        <top-back
          :title="language.TITLE_TEXT"
          :title-font-size="20"
          @click="$emit('closed', false)">
        </top-back>
        <div class="items">
          <div
            class="item"
            v-for="({ key, icon, name }) of items"
            :key="key"
            @click="selectLanguage(key)">
            <img :src="icon" class="icon" />
            <div class="name">{{ name }}</div>
          </div>
        </div>
      </div>
    </van-popup>
  `
})

Vue.component('switch-lines', {
  model: {
    prop: 'visible',
    event: 'closed'
  },
  props: {
    visible: {
      type: Boolean,
      default: false
    }
  },
  data: () => ({
    language: {},
    selectedIndex: 0,
    lines: [
      {
        name: 'Line01 (Singapore)',
        url: 'www.api17.com'
      },
      {
        name: 'Line02 (Asia)',
        url: 'www.api17.com'
      },
      {
        name: 'Line03 (America)',
        url: 'www.api17.com'
      },
      {
        name: 'Line04 (Europe)',
        url: 'www.api17.com'
      }
    ]
  }),
  created() {
    this.changeLanguage()
  },
  methods: {
    confirmLine() {
      const _this = this

      var item = _this.lines[_this.selectedIndex]
      APP.GLOBAL.setItem(APP.CONFIG.SYSTEM_KEYS.APP_BASE_URL_KEY, item.url)
      var queryUrl = APP.CONFIG.BASE_URL+'Public_Test'
      APP.GLOBAL.toastLoading({ 'message': _this.language.TOAST_LOADING_TEXT })
      _this.doTestAjax(queryUrl)
    },

    doTestAjax: function (queryUrl, callback) {
      const _this = this

      APP.GLOBAL.ajax({
        url: queryUrl,
        ontimeout: function () {
          APP.GLOBAL.closeToastLoading()
          APP.GLOBAL.toastMsg(_this.language.TIMEOUT_TEXT)
        },
        success: function (result) {
          if (!APP.GLOBAL.queryString('from')) {
            if (result.IsAvailable) {
              // APP.GLOBAL.gotoNewWindow('mainPage', 'pages/home')
              _this.$emit('closed', false)
            } else {
              _this.$emit('closed', false)
              // APP.GLOBAL.gotoNewWindow('loginPage', 'pages/account/login')
            }
          } else if (APP.GLOBAL.queryString('from') === 'login') {
            // APP.GLOBAL.closeWindow()
            _this.$emit('closed', false)
          }else {
            _this.$toast.success({
              'message': _this.language.CHANGE_SUCCESS,
              'duration': 1500
            });
            setTimeout(function () {
              _this.$emit('closed', false)
              // APP.GLOBAL.closeWindow()
            }, 1500);
          }

          APP.GLOBAL.closeToastLoading()
        },
        error: function () {
          APP.GLOBAL.closeToastLoading()
          APP.GLOBAL.toastMsg(_this.language.TIMEOUT_TEXT)
        }
      })
    },

    changeLanguage() {
      const _this = this

      LSE.install('index', function (lang) {
        Vue.set(_this, 'language', lang)
      })
    }
  },
  template: `
    <van-popup
      v-model="visible"
      position="bottom"
      style="background-color: transparent;"
      :overlay-style="{ backgroundColor: 'rgba(0, 0, 0, .7)' }"
      :get-container="() => document.body"
      @closed="$emit('closed', false)">
      <div class="Index">
        <top-back
          :title="language.TITLE_TEXT"
          :title-font-size="22"
          @click="$emit('closed', false)">
        </top-back>
        <div class="items">
          <div
            class="item"
            v-for="({ name, url }, index) of lines"
            :key="index"
            @click="selectedIndex = index">
            <div class="name">{{ name }}</div>
            <checkbox :checked="selectedIndex === index"></checkbox>
          </div>
        </div>
        <custom-button :text="language.CONFIRM_BUTTON" :height="53" @click="confirmLine"></custom-button>
      </div>
    </van-popup>
  `
})

Vue.component('top-back2', {
  props: {
    title: {
      type: String,
      required: true
    },
    titleFontSize: {
      type: Number,
      required: false,
      default: 18
    },
    titleColor: {
      type: String,
      required: false,
      default: '#333'
    },
  },
  methods: {
    handleClick() {
      const _this = this
      const $listeners = _this.$listeners
      const clickEvent = $listeners['click']

      clickEvent ? clickEvent() : APP.GLOBAL.closeWindow()
    }
  },

  template: `
    <div class="TopBack2">
      <div class="icon" @click="handleClick"></div>
      <div class="title" :style="{ fontSize: titleFontSize + 'px', color: titleColor }">
        {{ title }}
      </div>
      <slot name="right"></slot>
    </div>
  `
})

/** -------- 缺省页 ------------ */
Vue.component('no-data', {
  props: {
    index: {
      type: Number,
      required: false,
      default: 3
    },
    text: {
      type: String,
      required: false,
      default: ''
    }
  },
  data: () => ({
     language: {},
  }),
  created() {
    const _this = this

    _this.changeLanguage()
  },
  methods: {
    changeLanguage() {
      const _this = this

      LSE.install('NoData', function(lang) {
          Vue.set(_this, 'language', lang)
      });
    }
  },
  computed: {
    items() {
      const _this = this

      return [
        { image: '/assets/images/no-data/image1@3x.png', text: _this.language.t1 },
        { image: '/assets/images/no-data/image2@3x.png', text: _this.language.t2 },
        { image: '/assets/images/no-data/image3@3x.png', text: _this.language.t3 },
        { image: '/assets/images/no-data/image4@3x.png', text: _this.language.t4 },
      ]
    },

    getAssets() {
      const _this = this

      return _this.items[_this.index]
    }
  },
  template: `
    <div class="NoData">
      <div
        class="image"
        :style="{ width: '240px', backgroundImage: 'url(' + getAssets.image + ')' }">
      </div>
      <div class="text">{{ text || getAssets.text }}</div>
    </div>
  `
})

Vue.component('verify-identity-modal', {
  model: {
    prop: 'visible',
    event: 'closed'
  },
  props: {
    visible: Boolean,

    question: String,
  },
  data: () => ({
    value: '',
    language: {}
  }),
  created() {
    const _this = this

    _this.changeLanguage()
  },
  methods: {
    changeLanguage() {
      const _this = this

      LSE.install('VerifyIdentityModal', function(lang) {
          Vue.set(_this, 'language', lang)
      });
    },
    handleClosed() {
      const _this = this

      _this.$emit('closed', false)
      _this.value = ''
    },

    handleCancel() {
      const _this = this

      _this.$emit('closed', false)
    },

    handleConfirm() {
      const _this = this

      _this.$emit('confirm', _this.value)
      _this.$emit('closed', false)
    }
  },
  template: `
    <van-popup
      style="background-color: transparent;"
      v-model="visible"
      :overlay-style="{ backgroundColor: 'rgba(0, 0, 0, .7)' }"
      @closed="handleClosed">
      <div class="VerifyIdentityModal">
        <div class="content">
          <div class="title">{{ language.t1 }}</div>
          <div class="question-container">
            <div class="question-title">{{ question }}</div>
            <input
              class="input"
              :placeholder="language.t2"
              v-model="value"
            />
          </div>
          <div class="action-buttons">
            <div class="cancel" @click="handleCancel">{{ language.t3 }}</div>
            <div class="confirm" @click="handleConfirm">{{ language.t4 }}</div>
          </div>
        </div>
      </div>
    </van-popup>
  `
})

Vue.component('ep-selling-instructions-modal', {
  model: {
    prop: 'visible',
    event: 'closed'
  },
  props: {
    visible: Boolean
  },
  data: () => ({
    language: {}
  }),
  created() {
    const _this = this

    _this.changeLanguage()
  },
  methods: {
    changeLanguage() {
      const _this = this

      LSE.install('EpSellingInstructionsModal', function(lang) {
          Vue.set(_this, 'language', lang)
      });
    },
  },
  computed: {
    items() {
      const _this = this

      return [
        { text: _this.language.t1 },
        { text: _this.language.t2 },
        { text: _this.language.t3 },
      ]
    }
  },
  template: `
    <van-popup
      style="background-color: transparent;"
      v-model="visible"
      :overlay-style="{ backgroundColor: 'rgba(0, 0, 0, .7)' }"
      @closed="$emit('closed', false)">
      <div class="EpSellingInstructionsModal">
        <div class="content">
          <div class="title">{{ language.t4 }}</div>
          <div class="items">
            <div class="item" v-for="({ text }, index) of items" :key="index">
              {{ text }}
            </div>
          </div>
          <div class="button">
            <custom-button :text="language.t5" :height="53" @click="$emit('closed', false)"></custom-button>
          </div>
        </div>
      </div>
    </van-popup>
  `
})

Vue.component('registration-type-modal', {
  model: {
    prop: 'visible',
    event: 'closed'
  },
  props: {
    visible: Boolean
  },
  data: (_this) => ({
    selectedKey: _this.getDefaultSelectedKey(),
    language: {}
  }),
  created() {
    const _this = this

    _this.changeLanguage()
  },
  computed: {
    items() {
      const _this = this

      return [
        { key: '1', text: _this.language.t1 },
        { key: '2', text: _this.language.t2 }
      ]
    }
  },
  methods: {
    changeLanguage() {
      const _this = this

      LSE.install('RegistrationTypeModal', function(lang) {
          Vue.set(_this, 'language', lang)
      });
    },
    getDefaultSelectedKey() {
      return '1'
    },
    handleClosed() {
      const _this = this

      _this.$emit('closed', false)
      _this.selectedKey = _this.getDefaultSelectedKey()
    },

    handleConfirm() {
      const _this = this

      _this.$emit('confirm', _this.selectedKey)
      _this.handleClosed()
    },

    handleCancle() {
      const _this = this

      _this.handleClosed()
    }
  },
  template: `
    <van-popup
      style="background-color: transparent;"
      v-model="visible"
      :overlay-style="{ backgroundColor: 'rgba(0, 0, 0, .7)' }"
      @closed="handleClosed">
      <div class="RegistrationTypeModal">
        <div class="content">
          <div class="title">{{ language.t3 }}</div>
          <div class="items">
            <div
              class="item"
              v-for="({ text, key }, index) of items"
              :key="index"
              @click="selectedKey = key">
              <div class="text">{{ text }}</div>
              <div class="select" :class="{ active: key === selectedKey }"></div>
            </div>
          </div>
          <div class="action-buttons">
            <custom-button :text="language.t4" @click="handleConfirm"></custom-button>
            <div class="cancel" @click="handleCancle">{{ language.t5 }}</div>
          </div>
        </div>
      </div>
    </van-popup>
  `
})

Vue.component('fan-list-corresponding-diagram-modal', {
  model: {
    prop: 'visible',
    event: 'closed'
  },
  props: {
    visible: Boolean
  },
  data: () => ({
    notPromptAgainisActive: false,
    language: {}
  }),
  created() {
    const _this = this

    _this.changeLanguage()
  },
  methods: {
    changeLanguage() {
      const _this = this

      LSE.install('FanListCorrespondingDiagramModal', function(lang) {
          Vue.set(_this, 'language', lang)
      });
    },
  },
  template: `
    <van-popup
      style="background-color: transparent;"
      v-model="visible"
      :overlay-style="{ backgroundColor: 'rgba(0, 0, 0, .7)' }"
      @closed="$emit('closed', false)">
      <div class="FanListCorrespondingDiagramModal">
        <div class="content">
          <div class="title">{{ language.t1 }}</div>
          <div class="relationship-diagram">
            <img class="image" src="/assets/images/image9@3x.png" />
            <div class="text">{{ language.t2 }}</div>
          </div>
          <div
            class="not-prompt-again"
            :class="{ active: notPromptAgainisActive }"
            @click="notPromptAgainisActive = !notPromptAgainisActive">
            {{ language.t3}}
          </div>
          <div class="button">
            <custom-button :text="language.t4" @click="$emit('closed', false)"></custom-button>
          </div>
        </div>
      </div>
    </van-popup>
  `
})

Vue.component('update-image', {
  model: {
    prop: 'visible',
    event: 'closed'
  },
  props: {
    visible: Boolean
  },
  data: () => ({
    language: {},

    awaitUpdateImageResolve: null,

    data: null
  }),
  created() {
    const _this = this

    _this.changeLanguage()
  },
  methods: {
    changeLanguage() {
      const _this = this

      LSE.install('UpdateImage', function(lang) {
          Vue.set(_this, 'language', lang)
      });
    },

    /**
     * 处理点击
     * @prop { Number } type 类型
     */
    async handleItemClick(type) {
      const _this = this
      const { promise, resolve } = Promise.withResolvers()

      _this.awaitUpdateImageResolve = resolve
      _this.$refs.fileRef.click()

      const result = await promise

      _this.data = result
    },

    fileChanged(event) {
      const _this = this
      if (!window.FileReader) {
          APP.GLOBAL.toastMsg(_this.language.t1);
          return;
      }

      if (event.target.files.length === 0) {
          APP.GLOBAL.toastMsg(_this.language.t2);
          return;
      }

      var file = event.target.files[0];
      var extIndex = file.name.lastIndexOf('.');
      if (extIndex === -1) {
          APP.GLOBAL.toastMsg(_this.language.t3);
          return;
      }

      var ext = file.name.substring(extIndex).toLowerCase();
      if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png') {
          APP.GLOBAL.toastMsg(_this.language.t4);
          return;
      }

      if (file.size > Math.pow(1024, 2) * 2) {
          APP.GLOBAL.toastMsg(_this.language.t5);
          return;
      }
      _this.awaitUpdateImageResolve({ fileName: file.name, file })
    },

    handleConfirm() {
      const _this = this

      _this.$emit('confirm', _this.data)
      _this.handleClosed()
    },

    handleClosed() {
      const _this = this

      _this.$emit('closed', false)
      _this.awaitUpdateImageResolve = null
      _this.data = null
    }
  },
  computed: {
    getItems() {
      const _this = this

      return [
        { type: 0, icon: '/assets/svg/icon25.svg', text: _this.language.t6 },
        { type: 1, icon: '/assets/svg/icon26.svg', text: _this.language.t7 }
      ]
    }
  },
  template: `
    <van-popup
      v-model="visible"
      position="bottom"
      style="background-color: transparent;"
      :overlay-style="{ backgroundColor: 'rgba(0, 0, 0, .7)' }"
      :get-container="() => document.body"
      @closed="$emit('closed', false)">
      <div class="UpdateImage">
        <input type="file" hidden ref="fileRef" @change="fileChanged" />
        <div class="content">
          <div class="items">
            <div class="item"
              v-for="(item, index) of getItems"
              :key="index"
              @click="handleItemClick(item.type)">
              <div class="left">
                <img class="icon" :src="item.icon" />
                <div class="text">{{ item.text }}</div>
              </div>
              <img class="arrow" src="/assets/svg/icon4.svg" />
            </div>
          </div>
          <div class="button">
            <custom-button @click="handleConfirm" :text="language.t8" :height="53"></custom-button>
          </div>
        </div>
      </div>
    </van-popup>
  `
})

Vue.component('special-shaped-layout', {
  template: `
    <div class="SpecialShapedLayout">
      <div class="bg"></div>
      <slot></slot>
    </div>
  `
})

Vue.component('special-shaped-layout2', {
  template: `
    <div class="SpecialShapedLayout2">
      <div class="bg"></div>
      <slot></slot>
    </div>
  `
})

Vue.component('special-shaped-layout3', {
  template: `
    <div class="SpecialShapedLayout3">
      <div class="bg"></div>
      <slot></slot>
    </div>
  `
})

Vue.component('special-shaped-layout4', {
  template: `
    <div class="SpecialShapedLayout4">
      <div class="bg"></div>
      <slot></slot>
    </div>
  `
})

Vue.component('item', {
  props: {
    itemColorBlock: String,
    text: String
  },
  template: `
    <div class="Item">
      <div class="item-color-block" :style="{ background: itemColorBlock }"></div>
      <div class="item-text">{{ text}}</div>
    </div>
  `
})


Vue.component('recharge-close-modal', {
  model: {
    prop: 'visible',
    event: 'closed'
  },
  props: {
    visible: Boolean
  },
  data: () => ({
    language: {}
  }),
  created() {
    const _this = this

    _this.changeLanguage()
  },
  methods: {
    changeLanguage() {
      const _this = this

      LSE.install('RechargeCloseModal', function(lang) {
          Vue.set(_this, 'language', lang)
      });
    },
  },
  template: `
    <van-popup
      style="background-color: transparent;"
      v-model="visible"
      :overlay-style="{ backgroundColor: 'rgba(0, 0, 0, .7)' }"
      :close-on-click-overlay="false">
      <div class="RechargeCloseModal">
        <div class="content">
          <div class="title">{{ language.t1 }}</div>
          <div class="text">{{ language.t2 }}</div>
        </div>
      </div>
    </van-popup>
  `
})